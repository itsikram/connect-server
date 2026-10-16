const { prisma, isValidId, toId, populated } = require('../utils/db')
const { saveNotification } = require('./notificationController')
const checkIsActive = require('../utils/checkIsActive')
const { sendPushToProfile } = require('../utils/pushNotifications')
const { normalizeReactType } = require('../utils/reactTypes')
const { updateInterestProfile } = require('../services/recommendationService')
const { postInclude, watchInclude, storyInclude, shapePost, shapeWatch, shapeStory } = require('../services/contentShape')

// Reacts are join rows unique per (target, profile); the old document had the
// newest react last, so replacing = delete + create.
const TARGETS = {
    post: { model: 'post', react: 'postReact', key: 'post', include: () => postInclude({ author: false }), shape: shapePost },
    story: { model: 'story', react: 'storyReact', key: 'story', include: () => storyInclude({ author: false }), shape: shapeStory },
    watch: { model: 'watch', react: 'watchReact', key: 'watch', include: () => watchInclude({ author: false }), shape: shapeWatch },
}

// Reacted document in its old unpopulated shape (reacts, comments ids, aiMetadata...)
const loadTarget = async (target, id) =>
    target.shape(await prisma[target.model].findUnique({ where: { id }, include: target.include() }))

const findWithAuthor = async (target, id) => {
    if (!isValidId(id)) return null
    const row = await prisma[target.model].findUnique({ where: { id: String(id) }, select: { id: true, author: true, authorDoc: true } })
    return row ? populated(row, 'author').author : null
}

const replaceReact = async (target, id, profileId, reactType) => {
    if (!isValidId(id)) return null
    id = String(id)
    profileId = toId(profileId)
    const exists = await prisma[target.model].findUnique({ where: { id }, select: { id: true } })
    if (!exists) return null
    await prisma.$transaction([
        prisma[target.react].deleteMany({ where: { [target.key]: id, profile: profileId } }),
        prisma[target.react].create({ data: { [target.key]: id, profile: profileId, type: reactType } }),
    ])
    return loadTarget(target, id)
}

const removeReact = async (target, id, profileId) => {
    if (!isValidId(id)) return null
    id = String(id)
    const exists = await prisma[target.model].findUnique({ where: { id }, select: { id: true } })
    if (!exists) return null
    await prisma[target.react].deleteMany({ where: { [target.key]: id, profile: toId(profileId) } })
    return loadTarget(target, id)
}

exports.postAddReact = async (req, res, next) => {
    try {
        const profile = toId(req.profile._id)
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

        let connectProfile = ''

        switch (postType) {
            case 'post': {
                connectProfile = await findWithAuthor(TARGETS.post, id)
                const addPostReact = await replaceReact(TARGETS.post, id, profile, reactType)
                if (!addPostReact) {
                    return res.status(404).json({ message: 'Post not found' })
                }
                updateInterestProfile({ profileId: profile, item: addPostReact }).catch((error) => console.error('[recommendations] post interest update failed:', error.message || error))

                if (connectProfile && String(connectProfile._id) !== String(profile)) {
                    const activeBrowserIds = connectProfile.browserIds
                        ?.filter(browser => browser.isActive)
                        ?.map(browser => browser.browserId) || []

                    saveNotification(io, {
                        receiverId: connectProfile._id,
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

                    io.to(connectProfile._id).emit('postReactNotification', {
                        senderName: myProfileData.fullName,
                        senderPP: myProfileData.profilePic,
                        postId: addPostReact._id,
                        reactType: reactType
                    })

                    try {
                        const { isActive } = await checkIsActive(connectProfile._id)
                        if (!isActive) {
                            await sendPushToProfile(connectProfile._id, {
                                title: 'New reaction',
                                body: `${myProfileData.fullName} reacted to your post`,
                                image: myProfileData.profilePic,
                                data: { type: 'post_react', postId: String(addPostReact._id) }
                            })
                        }
                    } catch (e) {}
                }

                return res.status(200).json(addPostReact)
            }
            case 'story': {
                connectProfile = await findWithAuthor(TARGETS.story, id)
                const addStoryReact = await replaceReact(TARGETS.story, id, profile, reactType)
                if (!addStoryReact) {
                    return res.status(404).json({ message: 'Story not found' })
                }

                if (connectProfile && String(connectProfile._id) !== String(profile)) {
                    saveNotification(io, {
                        receiverId: connectProfile._id,
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
                        const { isActive } = await checkIsActive(connectProfile._id)
                        if (!isActive) {
                            await sendPushToProfile(connectProfile._id, {
                                title: 'New reaction',
                                body: `${myProfileData.fullName} reacted to your story`,
                                image: myProfileData.profilePic,
                                data: { type: 'story_react', storyId: String(addStoryReact._id) }
                            })
                        }
                    } catch (e) {}
                }

                return res.status(200).json(addStoryReact)
            }
            case 'watch': {
                connectProfile = await findWithAuthor(TARGETS.watch, id)
                const addWatchReact = await replaceReact(TARGETS.watch, id, profile, reactType)
                if (!addWatchReact) {
                    return res.status(404).json({ message: 'Video not found' })
                }
                updateInterestProfile({ profileId: profile, item: addWatchReact }).catch((error) => console.error('[recommendations] watch interest update failed:', error.message || error))

                if (connectProfile && String(connectProfile._id) !== String(profile)) {
                    const activeBrowserIds = connectProfile.browserIds
                        ?.filter(browser => browser.isActive)
                        ?.map(browser => browser.browserId) || []

                    saveNotification(io, {
                        receiverId: connectProfile._id,
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

                    io.to(connectProfile._id).emit('postReactNotification', {
                        senderName: myProfileData.fullName,
                        senderPP: myProfileData.profilePic,
                        watchId: addWatchReact._id,
                        reactType: reactType
                    })

                    try {
                        const { isActive } = await checkIsActive(connectProfile._id)
                        if (!isActive) {
                            await sendPushToProfile(connectProfile._id, {
                                title: 'New reaction',
                                body: `${myProfileData.fullName} reacted to your video`,
                                image: myProfileData.profilePic,
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
                const removePostReact = await removeReact(TARGETS.post, id, reactor)
                return res.status(200).json(removePostReact)
            }
            case 'story': {
                const removeStoryReact = await removeReact(TARGETS.story, id, profile)
                return res.status(200).json(removeStoryReact)
            }
            case 'watch': {
                const removeWatchReact = await removeReact(TARGETS.watch, id, reactor)
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
