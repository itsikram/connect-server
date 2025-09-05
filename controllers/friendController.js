const Profile = require('../models/Profile')
const mongoose = require('mongoose')
const { saveNotification } = require('./notificationController')
const { sendPushToProfile } = require('../utils/pushNotifications')
const sendEmailNotification = require('../utils/sendEmailNotification.js')
const checkIsActive = require('../utils/checkIsActive.js')
exports.postFrndReq = async (req, res, next) => {
    try {
        let profile = req.body.profile || req.body.profileId || req.query.profileId
        if (!profile || !mongoose.Types.ObjectId.isValid(profile)) {
            return res.status(400).json({ message: 'Invalid or missing profile id' })
        }
        let io = req.app.get('io')

        let myProfile = await Profile.findById(req.profile._id)
        if (!myProfile) {
            return res.status(401).json({ message: 'Unauthorized' })
        }

        if (myProfile._id.equals(profile)) {
            return res.status(400).json({ message: 'Cannot send friend request to yourself' })
        }

        if (myProfile.friends?.some(id => id.equals(profile))) {

            return res.json({
                message: 'Already Friend'
            })
        }

        let frndProfile = await Profile.findOne({
            _id: profile,
            'friends': {
                $ne: myProfile._id,
            }
        }).populate('user')

        if (!frndProfile) {
            return res.status(404).json({ message: 'Profile not found' })
        }

        if (frndProfile.friendReqs?.some(id => id.equals(myProfile._id))) {
            return res.json({
                message: 'Already Requested'
            })
        }

        let frndReq = await Profile.findOneAndUpdate({
            _id: frndProfile._id,
            friendReqs: {
                $ne: myProfile._id,
            }
        }, {
            $push: {
                friendReqs: myProfile._id,
            }
        }, { new: true })



        let {
            isActive,
            lastLogin
        } = await checkIsActive(profile)


        if (isActive && String(profile) !== String(myProfile._id)) {
            let notificationData = {
                receiverId: profile,
                text: myProfile.fullName + ' Sent you friend Request',
                link: '/' + myProfile._id,
                icon: myProfile.profilePic,
                type: 'friendReq'
            }

            saveNotification(io, notificationData)
        } else if (String(profile) !== String(myProfile._id)) {
            try {
                await sendPushToProfile(profile, {
                    title: 'New friend request',
                    body: `${myProfile.fullName} sent you a friend request`,
                    data: { type: 'friend_request', senderId: String(myProfile._id) }
                });
            } catch (e) {}
            sendEmailNotification(frndProfile?.user?.email, 'You\'ve received a friend requiest', myProfile.fullName + ' Sent you friend Request On Connect', myProfile.fullName)

        }


        return res.json(frndReq)


    } catch (error) {
        next(error)
    }

}

exports.postBlockFrnd = async (req, res, next) => {
    try {

        let friendId = req.body.friendId
        let profile = req.profile;

        let updateProfile = await Profile.findOneAndUpdate({ _id: profile._id }, {
            $push: {
                blockedUsers: friendId
            }
        })

        if (updateProfile) {
            return res.status(200).json({ message: 'User Block Successfully' })
        }

        return res.status(400).json({ message: 'User Cannot Be blocked' })



    } catch (error) {
        next(error)
    }
}
exports.postUnblockFrnd = async (req, res, next) => {
    try {

        let friendId = req.body.friendId
        let profile = req.profile;

        let updateProfile = await Profile.findOneAndUpdate({ _id: profile._id }, {
            $pull: {
                blockedUsers: friendId
            }
        })

        if (updateProfile) {
            return res.status(200).json({ message: 'User Unlock Successfully' })
        }

        return res.status(400).json({ message: 'User Cannot Be unblocked' })



    } catch (error) {
        next(error)
    }
}

exports.getFrndReq = async (req, res, next) => {
    try {

        let myProfile = req.profile
        let profile = req.query.profile;
        let myProfileReqsId = myProfile.friendReqs
        let getFrndReqsInfo = await Profile.find({
            _id: myProfileReqsId
        }).populate({
            path: 'user',
            select: ['firstName', 'surname']
        }).select('profilePic').sort({ createdAt: -1 })
        return res.status(200).json(getFrndReqsInfo)

    } catch (error) {
        next(error)
    }
}
exports.getProfileFrnd = async (req, res, next) => {

    try {
        let profile = req.query.profile

        if (profile == false) return next();
        let isSingle = req.query.single && req.query.single
        if (isSingle) {
            let friendData = await profile.findOne({ _id: profile })
            return res.json(friendData)
        }

        let friendProfile = await Profile.findOne({
            _id: profile
        }).select(['friends']).populate({
            path: 'friends',
            select: ['profilePic'],
            populate: {
                path: 'user',
                select: ['firstName', 'surname', 'profile']
            }
        })

        let friendsData = friendProfile.friends ? friendProfile.friends : { message: 'No Friends Found' }
        res.json(friendsData)


    } catch (error) {
        next(error)
    }

}

exports.getProfileSuggetions = async (req, res, next) => {
    try {

        let profile = req.profile
        let myFriends = req.profile.friends

        let getFrndSuggetions = await Profile.find({
            _id: {
                "$nin": myFriends,
                "$ne": profile._id
            },
        }).populate('user')

        res.json(getFrndSuggetions)

    } catch (error) {
        next(error)
    }
}



exports.postFrndAccept = async (req, res, next) => {
    try {
        let profile = req.body.profile

        let myProfile = req.profile
        let io = req.app.get('io')
        let updateFrndProfile = await Profile.findOneAndUpdate({
            _id: profile,
            friends: {
                $ne: myProfile._id,
            }
        }, {
            $push: {
                friends: myProfile._id
            }
        })
        let updateMyProfile = await Profile.findByIdAndUpdate({
            _id: myProfile._id,
            friends: {
                $ne: profile,
            }
        }, {
            $push: {
                friends: profile
            },
        })

        let updateFrnd = await Profile.findOneAndUpdate({
            _id: myProfile._id
        }, {
            $pull: {
                friendReqs: profile
            }
        }, { new: true })

        let notificationData = {
            receiverId: profile,
            text: myProfile.fullName + ' Accepted your friend Request',
            link: '/' + myProfile._id,
            icon: myProfile.profilePic,
            type: 'friendReqAccept'
        }

        saveNotification(io, notificationData)
        try {
            const { isActive } = await checkIsActive(profile)
            if (!isActive) {
                await sendPushToProfile(profile, {
                    title: 'Friend request accepted',
                    body: `${myProfile.fullName} accepted your friend request`,
                    data: { type: 'friend_accept', senderId: String(myProfile._id) }
                });
            }
        } catch (e) {}

        return res.status(200).json({
            message: 'Friend Request Accepted'
        })


    } catch (error) {
        next(error)
    }


}

exports.postFrndDelete = async (req, res, next) => {
    try {
        let friendProfileId = req.body.profile
        let myProfile = req.profile

        let updateMyProfile = await Profile.findOneAndUpdate({
            _id: myProfile._id
        }, {
            $pull: {
                friendReqs: friendProfileId
            }
        }, { new: true })

        res.json(updateMyProfile)

    } catch (error) {
        next(error)
    }

}

exports.postRemoveFrndReq = async (req, res, next) => {
    try {
        let frndProfileId = req.body.profile
        let myProfile = req.profile

        let updateFrnd = await Profile.findOneAndUpdate({
            _id: frndProfileId
        }, {
            $pull: {
                friendReqs: myProfile._id
            }
        }, { new: true })
        res.json(updateFrnd)

    } catch (e) {
        next(e)
    }
}

exports.postRemoveFrnd = async (req, res, next) => {
    try {

        let myProfile = req.profile
        let frndProfile = req.body.profile || req.body.profileId || req.query.profileId
        if (!frndProfile || !mongoose.Types.ObjectId.isValid(frndProfile)) {
            return res.status(400).json({ message: 'Invalid or missing profile id' })
        }



        let updateMyProfile = await Profile.findOneAndUpdate({
            _id: myProfile._id
        }, {
            $pull: {
                friends: frndProfile
            }
        })

        let updateFrndProfile = await Profile.findByIdAndUpdate(
            { _id: frndProfile },
            {
            $pull: {
                friends: myProfile._id
            }
        })

        if (updateMyProfile && updateFrndProfile) {

            return res.json({
                message: 'Friend removed From your profile'
            })
        }

        return res.status(404).json({ message: 'Friend relationship not found' })

    } catch (error) {
        next(error)
    }
}
