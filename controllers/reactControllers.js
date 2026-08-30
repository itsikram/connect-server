const Post = require('../models/Post')
const Story = require('../models/Story')
const Watch = require('../models/Watch')
const Profile = require('../models/Profile')
const { saveNotification } = require('./notificationController')
const checkIsActive = require('../utils/checkIsActive')
const { sendPushToProfile } = require('../utils/pushNotifications')
const { normalizeReactType } = require('../utils/reactTypes')

exports.postAddReact = async (req, res, next) => {
    try {

        let profile = (req.profile._id).toString()
        let myProfileData = req.profile
        let { reactType, id, postType, watchType } = req.body
        postType = postType || watchType
        reactType = normalizeReactType(reactType)
        let io = req.app.get('io')

        if (!reactType) {
            return res.status(400).json({ message: 'Invalid reaction type' })
        }
        if (!id || !['post', 'story', 'watch'].includes(postType)) {
            return res.status(400).json({ message: 'Invalid reaction target' })
        }

        let friendProfile = ''

        switch (postType) {
            case 'post':
                friendProfile = (await Post.findOne({ _id: id }).populate('author')).author
                await Post.findOneAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: profile,
                        }
                    }
                }, { new: true })

                let addPostReact = await Post.findOneAndUpdate({
                    _id: id
                }, {
                    $push: {
                        reacts: {
                            profile,
                            type: reactType
                        }
                    }

                }, { new: true })



                if (String(friendProfile._id) !== String(profile)) {
                    // Get all active browser IDs for the post author
                    const activeBrowserIds = friendProfile.browserIds
                        ?.filter(browser => browser.isActive)
                        ?.map(browser => browser.browserId) || [];

                    let postReactNotification = {
                        receiverId: friendProfile._id,
                        text: `${myProfileData.fullName} Reacted your post`,
                        link: '/post/' + addPostReact._id,
                        type: 'postReact',
                        icon: myProfileData.profilePic,
                        browserIds: activeBrowserIds,
                        data: {
                            senderId: profile,
                            senderName: myProfileData.fullName,
                            senderProfilePic: myProfileData.profilePic,
                            postId: addPostReact._id,
                            reactType: reactType
                        }
                    }
                    saveNotification(io, postReactNotification)

                    // Also emit specific socket event for post reaction
                    io.to(friendProfile._id).emit('postReactNotification', {
                        senderName: myProfileData.fullName,
                        senderPP: myProfileData.profilePic,
                        postId: addPostReact._id,
                        reactType: reactType
                    })

                    try {
                        const { isActive } = await checkIsActive(friendProfile._id)
                        if (!isActive) {
                            await sendPushToProfile(friendProfile._id, {
                                title: 'New reaction',
                                body: `${myProfileData.fullName} reacted to your post`,
                                data: { type: 'post_react', postId: String(addPostReact._id) }
                            });
                        }
                    } catch (e) {}
                }


                return res.json(addPostReact).status(200)
                break;
            case 'story':

            friendProfile = (await Story.findOne({ _id: id }).populate('author')).author

                await Story.findOneAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: profile,
                        }
                    }
                }, { new: true })

                let addStoryReact = await Story.findOneAndUpdate({
                    _id: id
                }, {
                    $push: {
                        reacts: {
                            profile,
                            type: reactType
                        }
                    }

                }, { new: true })

                if (String(friendProfile._id) !== String(profile)) {
                    let postStoryNotification = {
                        receiverId: friendProfile._id,
                        text: `${myProfileData.fullName} Reacted your Story`,
                        link: '/story/' + addStoryReact._id,
                        type: 'storyReact',
                        icon: myProfileData.profilePic,
                        data: {
                            senderId: profile,
                            senderName: myProfileData.fullName,
                            senderProfilePic: myProfileData.profilePic,
                            storyId: addStoryReact._id,
                            reactType: reactType
                        }
                    }
                    saveNotification(io, postStoryNotification)
                    try {
                        const { isActive } = await checkIsActive(friendProfile._id)
                        if (!isActive) {
                            await sendPushToProfile(friendProfile._id, {
                                title: 'New reaction',
                                body: `${myProfileData.fullName} reacted to your story`,
                                data: { type: 'story_react', storyId: String(addStoryReact._id) }
                            });
                        }
                    } catch (e) {}
                }

                return res.json(addStoryReact).status(200)
                break;
            case 'watch':

                friendProfile = (await Watch.findOne({ _id: id }).populate('author')).author
                await Watch.findOneAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: profile,
                        }
                    }
                }, { new: true })

                let addWatchReact = await Watch.findOneAndUpdate({
                    _id: id
                }, {
                    $push: {
                        reacts: {
                            profile,
                            type: reactType
                        }
                    }

                }, { new: true })

                if (friendProfile && String(friendProfile._id) !== String(profile)) {
                    const activeBrowserIds = friendProfile.browserIds
                        ?.filter(browser => browser.isActive)
                        ?.map(browser => browser.browserId) || [];

                    let watchReactNotification = {
                        receiverId: friendProfile._id,
                        text: `${myProfileData.fullName} Reacted your video`,
                        link: '/watch/' + addWatchReact._id,
                        type: 'postReact',
                        icon: myProfileData.profilePic,
                        browserIds: activeBrowserIds,
                        data: {
                            senderId: profile,
                            senderName: myProfileData.fullName,
                            senderProfilePic: myProfileData.profilePic,
                            watchId: addWatchReact._id,
                            reactType: reactType
                        }
                    }
                    saveNotification(io, watchReactNotification)

                    io.to(friendProfile._id).emit('postReactNotification', {
                        senderName: myProfileData.fullName,
                        senderPP: myProfileData.profilePic,
                        watchId: addWatchReact._id,
                        reactType: reactType
                    })

                    try {
                        const { isActive } = await checkIsActive(friendProfile._id)
                        if (!isActive) {
                            await sendPushToProfile(friendProfile._id, {
                                title: 'New reaction',
                                body: `${myProfileData.fullName} reacted to your video`,
                                data: { type: 'watch_react', watchId: String(addWatchReact._id) }
                            });
                        }
                    } catch (e) {}
                }

                return res.json(addWatchReact).status(200)
                break;

            default:
                return res.status(400).json({ message: 'Invalid reaction target' })
        }


    } catch (error) {
        console.log(error)
    }
}

exports.postRemoveReact = async (req, res, next) => {
    try {
        let profile = req.profile._id
        let { id, postType, watchType, reactor } = req.body
        postType = postType || watchType
        reactor = reactor || profile

        if (!id || !['post', 'story', 'watch'].includes(postType)) {
            return res.status(400).json({ message: 'Invalid reaction target' })
        }

        switch (postType) {
            case 'post':
                let removePostReact = await Post.findByIdAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: reactor,
                        }
                    }
                }, { new: true })

                return res.json(removePostReact)
                break;
            case 'story':
                let removeStoryReact = await Story.findByIdAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: profile,
                        }
                    }
                }, { new: true })

                return res.json(removeStoryReact)
                break;
            case 'watch':
                let removeWatchReact = await Watch.findByIdAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: reactor,
                        }
                    }
                }, { new: true })

                return res.json(removeWatchReact)
                break;

            default:
                return res.status(400).json({ message: 'Invalid reaction target' })
        }



    } catch (error) {
        next(error)
    }
}

exports.addStoryReact = async (req, res, next) => {

}
exports.deleteStoryReact = async (req, res, next) => {

}

