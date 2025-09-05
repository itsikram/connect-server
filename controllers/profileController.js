const Profile = require('../models/Profile')
const Post = require('../models/Post')
const Story = require('../models/Story')
const mongoose = require('mongoose')
const User = require('../models/User')


exports.prefileHasStory = async function (req, res, next) {
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    let profileId = req.query.profileId
    if (mongoose.isValidObjectId(profileId)) {
        let hasStory = await Story.exists({ author: profileId, createdAt: { $gte: twentyFourHoursAgo } })
        if (hasStory == null) {
            return res.json({ 'message': 'Story Not Available', 'hasStory': 'no' }).status(200)

        } else {
            return res.json({ 'message': 'Story Available', 'hasStory': 'yes' }).status(200)

        }
    } else {
        return res.json({ 'message': 'Story Not Available', 'hasStory': 'no' }).status(400)

    }

    return next()
}
exports.getProfileImages = async function (req, res, next) {
    let { profileId } = req.query
    try {
        if (!mongoose.isValidObjectId(profileId)) return
        let profileImages = await Post.find({

            author: profileId,
            photos: {
                $ne: 'null'
            }
        })

        if(profileImages) {
            return res.json(profileImages).status(200)
        }

        return next()


    } catch (error) {
        next(error)
    }


    return next()
}

exports.profileGet = async function (req, res, next) {
    try {
        console.log('profileGet called with query:', req.query?.profileId);
        let profileId = req.query.profileId;
        
        if (!profileId) {
            console.log('No profileId provided');
            return res.status(400).json({ message: 'Profile ID is required' });
        }

        console.log('Looking for profile with ID:', profileId);

        // Check if profileId is a username
        let hasUsername = await Profile.findOne({ username: profileId });
        if (hasUsername) {
            console.log('Found profile by username');
            let profileData = await Profile.findOne({ username: profileId }).populate('user');
            return res.status(200).json(profileData);
        }

        // Check if profileId is a valid ObjectId
        if (mongoose.isValidObjectId(profileId)) {
            console.log('ProfileId is valid ObjectId, searching by _id');
            let hasProfile = await Profile.findOne({ _id: profileId });
            if (!hasProfile) {
                console.log('Profile not found by _id');
                return res.status(404).json({ message: 'Profile Not Found' });
            }
            
            let profileData = await Profile.findOne({ _id: profileId }).populate(['friends', 'user']);
            
            if (profileData) {
                return res.status(200).json(profileData);
            } else {
                return res.status(404).json({ message: 'Profile data not found' });
            }
        } else {
            console.log('Invalid profile ID format:', profileId);
            return res.status(400).json({ message: 'Invalid profile ID format' });
        }
    } catch (error) {
        console.error('Error in profileGet:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
}


exports.profilePost = async (req, res, next) => {

    try {
        let profileId = req.body.profile
        if (profileId == false) return;

        if (mongoose.isValidObjectId(profileId)) {
            let hasProfile = await Profile.exists({ _id: profileId })
            if (!hasProfile) return res.json({ message: 'Profile Not Found' }).status(404)
            let profileData = await Profile.findOne({ _id: profileId }).populate(['friends', 'user'])
            if (profileData) {
                return res.json(profileData)
            }
        }


    } catch (error) {
        next(error)
    }

}
exports.updateCoverPost = async (req, res, next) => {

    let profileId = req.body.profile
    let coverPicUrl = req.body.coverPicUrl
    try {
        let updateProfile = await Profile.findOneAndUpdate({ _id: profileId }, {
            coverPic: coverPicUrl
        })
        res.json(updateProfile)




    } catch (error) {
        console.log(error)
    }


}

exports.updateProfilePic = async (req, res, next) => {
    let profileId = req.profile._id;
    let profilePicUrl = req.body.profilePicUrl
    let caption = req.body.caption
    let type = req.body.type || 'post'


    try {

        let post = new Post({
            type,
            caption,
            photos: profilePicUrl,
            author: profileId
        })

        let savedPost = await post.save()

        let updatedProfile = await Profile.findByIdAndUpdate({ _id: profileId }, {
            profilePic: profilePicUrl
        }, { new: true })

        if (savedPost && updatedProfile) {
            return res.json(updatedProfile)
        }

    } catch (error) {
        console.log(error)
    }
}

exports.updateBioPost = async (req, res, next) => {
    try {

        let bio = req.body.bio
        let updateProfile = await Profile.findByIdAndUpdate({
            _id: req.profile._id
        }, {
            bio
        }, { new: true })

        if (updateProfile) {
            res.json(updateProfile)
        }

    } catch (error) {
        console.log(error)
    }


}
exports.updateProfile = async (req, res, next) => {
    try {
        let reqData = { ...req.body }

        if (req.body.firstName && req.body.surname) {

            reqData.fullName = req.body.firstName + ' ' + req.body.surname

            let updatedUser = await User.findOneAndUpdate({ _id: req.profile.user }, {
                firstName: req.body.firstName,
                surname: req.body.surname
            }, { new: true })

        }


        let updateProfile = await Profile.findByIdAndUpdate({
            _id: req.profile._id
        }, {
            ...reqData
        }, { new: true }).populate('user')

        if (updateProfile) {
            res.json(updateProfile)
        }

    } catch (error) {
        console.log(error)
    }


}




