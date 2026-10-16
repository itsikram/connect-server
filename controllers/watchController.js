const { prisma, isValidId, toId, containsInsensitive } = require('../utils/db')
const generateAndUploadThumbnail = require('../utils/generateThumbnail')
const { enqueueCategorization } = require('../services/contentCategorizationQueue')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')
const {
    profileArgs,
    commentInclude,
    watchInclude,
    postInclude,
    shapeWatch,
    shapePost,
    deleteCommentsWhere,
    removeContent,
} = require('../services/contentShape')

// comments: author (profilePic, user{firstName, surname}), replies with full author
const watchComments = commentInclude(
    profileArgs(['profilePic'], ['firstName', 'surname']),
    profileArgs()
)

const fullWatchInclude = () => watchInclude({ author: profileArgs(), comments: watchComments })

exports.createWatch = async (req, res, next) => {
    const profileId = toId(req.profile._id)
    const caption = req.body.caption || ''
    const videoUrl = req.body.videoUrl
    const thumbnailUrl = req.body.thumbnailUrl
    const feeling = req.body.feeling || ''
    const audience = Number.isFinite(Number(req.body.audience))
        ? Number(req.body.audience)
        : 3

    try {
        if (!videoUrl || typeof videoUrl !== 'string') {
            return res.status(400).json({ message: 'videoUrl is required' })
        }

        const cloudinaryFrameThumb = (url) => {
            if (!url || !url.includes('/upload/')) return ''
            // Prefer Cloudinary video frame transform when available.
            return url
                .replace('/video/upload/', '/video/upload/so_1,w_720,h_405,c_fill/')
                .replace(/\.(mp4|mov|webm|mkv|avi)(\?.*)?$/i, '.jpg$2')
        }

        let thumbnail = thumbnailUrl || ''
        if (!thumbnail) {
            try {
                const result = await generateAndUploadThumbnail(videoUrl)
                thumbnail = result?.secure_url || ''
            } catch (thumbErr) {
                console.warn('Watch thumbnail generation failed, using fallback:', thumbErr.message)
                thumbnail = cloudinaryFrameThumb(videoUrl) || videoUrl
            }
        }

        const savedData = await prisma.watch.create({
            data: {
                caption,
                videoUrl,
                author: profileId,
                thumbnail,
                feeling,
                audience: Math.trunc(audience),
            },
        })
        enqueueCategorization(savedData.id, 'watch')
        const populated = shapeWatch(await prisma.watch.findUnique({
            where: { id: savedData.id },
            include: watchInclude({ author: profileArgs(['profilePic', 'fullName', 'displayName'], ['firstName', 'surname']) }),
        }))

        return res.status(200).json({
            message: 'Watch Created Successfully',
            data: populated || savedData,
        })
    } catch (error) {
        next(error)
    }
}

exports.deleteWatch = async (req, res, next) => {
    try {
        const profileId = toId(req.profile?._id)
        const watchId = req.body.watchId

        if (!profileId) {
            return res.status(401).json({ message: 'Authentication required' })
        }

        if (!watchId || !isValidId(watchId)) {
            return res.status(400).json({ message: 'Valid watchId is required' })
        }

        // Only the author can delete — verify ownership server-side
        const existing = await prisma.watch.findUnique({ where: { id: String(watchId) } })
        if (!existing) {
            return res.status(404).json({ message: 'Watch not found' })
        }
        if (existing.author !== profileId) {
            return res.status(403).json({ message: 'Not authorized to delete this watch' })
        }

        const { comments, replies, commentIds } = await deleteCommentsWhere({ watch: existing.id })
        await removeContent('watch', existing.id)
        await prisma.$transaction([
            prisma.cmntReply.deleteMany({ where: { parent: { in: commentIds } } }),
            prisma.comment.deleteMany({ where: { watch: existing.id } }),
        ])
        await deleteCloudinaryResources([
            existing.videoUrl,
            existing.thumbnail,
            ...comments.map((comment) => comment.attachment),
            ...replies.map((reply) => reply.attachment),
        ])
        return res.status(200).json({
            message: 'Watch Deleted Successfully',
            watchId,
        })
    } catch (error) {
        console.error('deleteWatch error:', error)
        return next(error)
    }
}

const listFields = {
    id: true, caption: true, thumbnail: true, videoUrl: true, youtubeId: true,
    feeling: true, audience: true, author: true, type: true, createdAt: true,
}

exports.getRelatedWatchs = async (req, res, next) => {

    try {
        const pageSize = Math.min(parseInt(req.query.limit, 10) || 24, 40);
        const watches = await prisma.watch.findMany({
            select: {
                ...listFields,
                authorDoc: profileArgs(['profilePic', 'fullName', 'displayName'], ['firstName', 'surname']),
                reacts: { orderBy: { createdAt: 'asc' }, select: { id: true, profile: true, type: true } },
                shares: { orderBy: { createdAt: 'asc' }, select: { id: true, profile: true } },
                comments: {
                    orderBy: { createdAt: 'asc' },
                    select: {
                        id: true, body: true, attachment: true, author: true, reacts: true,
                        authorDoc: profileArgs(['profilePic'], ['firstName', 'surname']),
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: pageSize,
        });

        return res.status(200).json(watches.map((watch) => {
            shapeWatch(watch)
            // these comments were never populated with replies
            watch.comments.forEach((comment) => { delete comment.replies })
            return watch
        }));

    } catch (error) {
        next(error)
    }
}

// Searches every Watch on the server by caption or author name, so clients are
// not limited to the most recent page returned by /related.
exports.searchWatches = async (req, res, next) => {
    try {
        const query = String(req.query.q || '').trim().slice(0, 100)
        if (!query) return res.status(200).json([])
        const pageSize = Math.min(parseInt(req.query.limit, 10) || 10, 30)

        const matchingProfiles = await prisma.profile.findMany({
            where: { OR: [{ fullName: containsInsensitive(query) }, { displayName: containsInsensitive(query) }] },
            select: { id: true },
            take: 50,
        })

        const or = [{ caption: containsInsensitive(query) }]
        if (matchingProfiles.length) {
            or.push({ author: { in: matchingProfiles.map((p) => p.id) } })
        }

        const watches = await prisma.watch.findMany({
            where: {
                AND: [{ videoUrl: { not: null } }, { videoUrl: { not: '' } }],
                OR: or,
            },
            select: {
                id: true, caption: true, thumbnail: true, videoUrl: true, youtubeId: true,
                author: true, type: true, createdAt: true,
                authorDoc: profileArgs(['profilePic', 'fullName', 'displayName'], ['firstName', 'surname']),
            },
            orderBy: { createdAt: 'desc' },
            take: pageSize,
        })

        return res.status(200).json(watches.map(shapeWatch))
    } catch (error) {
        next(error)
    }
}

exports.getMyWatchs = async (req, res, next) => {

    try {
        let profile_id = req.query.profile;
        if (profile_id == req.profile._id && !req.query.profile) {
            profile_id = req.profile._id
        }
        if (!isValidId(profile_id)) return res.json().status(400)
        const watchs = await prisma.watch.findMany({
            where: { author: toId(profile_id) },
            include: fullWatchInclude(),
            orderBy: { createdAt: 'desc' },
        })

        res.json(watchs.map(shapeWatch)).status(200)

    } catch (error) {
        next(error)
    }
}

exports.getSingleWatch = async (req, res, next) => {

    try {

        let { watchId } = req.query
        if (!isValidId(watchId)) return

        const watch = shapeWatch(await prisma.watch.findUnique({ where: { id: String(watchId) }, include: fullWatchInclude() }))

        if (watch) {
            return res.json(watch).status(200)
        }

    } catch (error) {
        console.log(error)
    }
}

exports.updateWatch = async (req, res, next) => {

    try {

        let { watchId, caption, audience } = req.body
        let authorId = toId(req.profile?._id)

        let updateFields = {}
        if (caption !== undefined) updateFields.caption = caption
        if (audience !== undefined) updateFields.audience = Math.trunc(Number(audience))

        if (!watchId || Object.keys(updateFields).length === 0) {
            return res.status(400).json({ message: 'Nothing to update' })
        }

        let where = { id: String(watchId) }
        if (authorId) where.author = authorId

        const { count } = isValidId(watchId) ? await prisma.watch.updateMany({ where, data: updateFields }) : { count: 0 }

        if (count) {
            enqueueCategorization(String(watchId), 'watch')
            const updatedWatch = shapeWatch(await prisma.watch.findUnique({ where: { id: String(watchId) }, include: watchInclude({ author: false }) }))
            return res.status(200).json({ message: 'Watch updated', watch: updatedWatch })
        }

        return res.status(404).json({ message: 'Watch not found or not authorized' })

    } catch (error) {
        console.log(error)
        return res.status(500).json({ message: 'Failed to update watch' })
    }
}


exports.getProfileWatch = async (req, res, next) => {
    const profileId = req.query.profile
    const pageNumber = Math.max(parseInt(req.query.pageNumber, 10) || 1, 1)
    const limit = 3
    try {
        const where = {}
        if (profileId) {
            if (!isValidId(profileId)) {
                return res.status(400).json({ message: 'Valid profile is required' })
            }
            where.author = String(profileId)
        }

        const newsFeedWatchs = await prisma.watch.findMany({
            where,
            include: fullWatchInclude(),
            orderBy: { createdAt: 'desc' },
            skip: (pageNumber - 1) * limit,
            take: limit,
        })

        const nextWatchs = await prisma.watch.findMany({
            where,
            select: { id: true },
            orderBy: { createdAt: 'desc' },
            skip: pageNumber * limit,
            take: limit,
        })

        let hasNewWatch = nextWatchs.length == 0 ? false : true
        res.json({ watchs: newsFeedWatchs.map(shapeWatch), hasNewWatch }).status(200)

    } catch (error) {
        console.log(error)
        next(error)
    }
}

exports.shareWatch = async (req, res, next) => {
    try {
        const profileId = toId(req.profile._id)
        const watchId = req.body.watchId
        const caption = req.body.caption || ''

        if (!isValidId(watchId)) {
            return res.status(400).json({ message: 'Watch share failed' })
        }

        const theWatch = await prisma.watch.findUnique({ where: { id: String(watchId) } })
        if (!theWatch) {
            return res.status(404).json({ message: 'Watch not found' })
        }

        const savedPost = await prisma.post.create({
            data: {
                caption,
                photos: theWatch.thumbnail || '',
                author: profileId,
                type: 'shareWatch',
                location: String(watchId),
                hashtags: [],
                gallery: [],
            },
        })

        await prisma.watchShare.create({ data: { watch: theWatch.id, profile: profileId } })
        const updateWatch = shapeWatch(await prisma.watch.findUnique({ where: { id: theWatch.id }, include: watchInclude({ author: false }) }))

        const getPost = shapePost(await prisma.post.findUnique({
            where: { id: savedPost.id },
            include: postInclude({ author: profileArgs(), comments: watchComments }),
        }))

        if (updateWatch && getPost) {
            return res.status(200).json({
                message: 'Watch Shared Successfully',
                post: getPost,
                watch: updateWatch,
            })
        }

        return res.status(400).json({ message: 'Watch share failed' })
    } catch (error) {
        next(error)
    }
}
