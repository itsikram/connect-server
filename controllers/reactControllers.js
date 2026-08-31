const Post = require('../models/Post')
const Story = require('../models/Story')
const Watch = require('../models/Watch')
const Profile = require('../models/Profile')
const { saveNotification } = require('./notificationController')
const checkIsActive = require('../utils/checkIsActive')
const { sendPushToProfile } = require('../utils/pushNotifications')
const { normalizeReactType } = require('../utils/reactTypes')

const reactProfileId = (value) => String(value?._id || value || '')

const withoutReactor = (reacts = [], profileId) =>
    (Array.isArray(reacts) ? reacts : []).filter(
        (react) => reactProfileId(react?.profile) !== reactProfileId(profileId)
    )

const uniqueReactsByProfile = (reacts = []) => {
    const seen = new Set()
    const next = []
    for (const react of [...(reacts || [])].reverse()) {
        const id = reactProfileId(react?.profile)
        if (!id || seen.has(id)) continue
        seen.add(id)
        next.push(react)
    }
    return next.reverse()
}

const replaceReact = async (Model, id, profileId, reactType) => {
    const doc = await Model.findById(id)
    if (!doc) return null
    const cleaned = uniqueReactsByProfile(withoutReactor(doc.reacts, profileId))
    cleaned.push({ profile: profileId, type: reactType })
    doc.reacts = cleaned
    await doc.save()
    return doc
}

const removeReact = async (Model, id, profileId) => {
    const doc = await Model.findById(id)
    if (!doc) return null
    doc.reacts = uniqueReactsByProfile(withoutReactor(doc.reacts, profileId))
    await doc.save()
    return doc
}

exports.postAddReact = async (req, res, next) => {
    try {
        const profile = req.profile._id
        const myProfileData = req.profile
        let { reactType, id, postType, watchType } = req.body
        postType = postType || watchType
        reactType = normalizeReactType(reactType)
        const io = req.app.get('io')

        if (!reactType) {
            return res.status(400).json({ message: 'Invalid reaction type' })
        }
        if (!id || !['post', 'story', 'watch'].includes(postType)) {
            return res.status(400).json({ message: 'Invalid reaction target' })
        }

        let friendProfile = ''

        switch (postType) {
            case 'post': {
                friendProfile = (await Post.findOne({ _id: id }).populate('author')).author
                const addPostReact = await replaceReact(Post, id, profile, reactType)
                if (!addPostReact) {
                    return res.status(404).json({ message: 'Post not found' })
                }

                if (String(friendProfile._id) !== String(profile)) {
                    const activeBrowserIds = friendProfile.browserIds
                        ?.filter(browser => browser.isActive)
                        ?.map(browser => browser.browserId) || []

                    saveNotification(io, {
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
                    })

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
                            })
                        }
                    } catch (e) {}
                }

                return res.status(200).json(addPostReact)
            }
            case 'story': {
                friendProfile = (await Story.findOne({ _id: id }).populate('author')).author
                const addStoryReact = await replaceReact(Story, id, profile, reactType)
                if (!addStoryReact) {
                    return res.status(404).json({ message: 'Story not found' })
                }

                if (String(friendProfile._id) !== String(profile)) {
                    saveNotification(io, {
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
                    })
                    try {
                        const { isActive } = await checkIsActive(friendProfile._id)
                        if (!isActive) {
                            await sendPushToProfile(friendProfile._id, {
                                title: 'New reaction',
                                body: `${myProfileData.fullName} reacted to your story`,
                                data: { type: 'story_react', storyId: String(addStoryReact._id) }
                            })
                        }
                    } catch (e) {}
                }

                return res.status(200).json(addStoryReact)
            }
            case 'watch': {
                friendProfile = (await Watch.findOne({ _id: id }).populate('author')).author
                const addWatchReact = await replaceReact(Watch, id, profile, reactType)
                if (!addWatchReact) {
                    return res.status(404).json({ message: 'Video not found' })
                }

                if (friendProfile && String(friendProfile._id) !== String(profile)) {
                    const activeBrowserIds = friendProfile.browserIds
                        ?.filter(browser => browser.isActive)
                        ?.map(browser => browser.browserId) || []

                    saveNotification(io, {
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
                    })

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
                            })
                        }
                    } catch (e) {}
                }

                return res.status(200).json(addWatchReact)
            }
            default:
                return res.status(400).json({ message: 'Invalid reaction target' })
        }
    } catch (error) {
        console.log(error)
        return res.status(500).json({ message: 'Failed to add reaction' })
    }
}

exports.postRemoveReact = async (req, res, next) => {
    try {
        const profile = req.profile._id
        let { id, postType, watchType, reactor } = req.body
        postType = postType || watchType
        reactor = reactor || profile

        if (!id || !['post', 'story', 'watch'].includes(postType)) {
            return res.status(400).json({ message: 'Invalid reaction target' })
        }

        switch (postType) {
            case 'post': {
                const removePostReact = await removeReact(Post, id, reactor)
                return res.status(200).json(removePostReact)
            }
            case 'story': {
                const removeStoryReact = await removeReact(Story, id, profile)
                return res.status(200).json(removeStoryReact)
            }
            case 'watch': {
                const removeWatchReact = await removeReact(Watch, id, reactor)
                return res.status(200).json(removeWatchReact)
            }
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
