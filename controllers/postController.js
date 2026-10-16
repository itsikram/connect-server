const { prisma, isValidId, toId, sameId } = require('../utils/db')
const { rankPosts } = require('../utils/feedRanking')
const { enqueueCategorization } = require('../services/contentCategorizationQueue')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')
const {
    profileArgs,
    commentInclude,
    postInclude,
    shapePost,
    shapeComment,
    audienceLists,
    audienceWhere,
    deleteCommentsWhere,
    removeContent,
} = require('../services/contentShape')

const mentionTokenPattern = /@\[[^\]]+\]\(([a-f\d]{24})\)/gi
const hashtagPattern = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]{1,50})/gu

const extractPostTags = async (caption) => {
    const text = String(caption || '')
    const hashtags = new Set()
    let hashtagMatch
    while ((hashtagMatch = hashtagPattern.exec(text))) {
        hashtags.add(hashtagMatch[2].toLowerCase())
    }
    hashtagPattern.lastIndex = 0

    const mentionIds = new Set()
    let mentionMatch
    while ((mentionMatch = mentionTokenPattern.exec(text))) {
        if (isValidId(mentionMatch[1])) mentionIds.add(mentionMatch[1].toLowerCase())
    }
    mentionTokenPattern.lastIndex = 0

    const usernames = []
    const usernamePattern = /(^|[^\p{L}\p{N}_])@([a-zA-Z0-9_.-]{3,50})/gu
    let usernameMatch
    while ((usernameMatch = usernamePattern.exec(text))) usernames.push(usernameMatch[2])
    if (usernames.length) {
        const profiles = await prisma.profile.findMany({ where: { username: { in: usernames } }, select: { id: true } })
        profiles.forEach((profile) => mentionIds.add(String(profile.id)))
    }

    return { hashtags: [...hashtags], mentions: [...mentionIds] }
}

// Mentions live in a join table; keep only ids that point at a profile.
const mentionRows = async (mentions) => {
    if (!mentions.length) return []
    const existing = await prisma.profile.findMany({ where: { id: { in: mentions } }, select: { id: true } })
    return existing.map((profile) => ({ profile: profile.id }))
}

const replaceMentions = async (postId, mentions) => {
    const rows = await mentionRows(mentions)
    await prisma.$transaction([
        prisma.postMention.deleteMany({ where: { post: postId } }),
        ...(rows.length ? [prisma.postMention.createMany({ data: rows.map((row) => ({ ...row, post: postId })), skipDuplicates: true })] : []),
    ])
}

const commentAuthor = profileArgs(
    ['profilePic', 'fullName', 'displayName', 'username', 'nickname'],
    ['firstName', 'surname']
)
const fullComments = commentInclude(commentAuthor)

// author (+ user), parentPost (+ author + user), comments (+ author, replies)
const fullPostInclude = (extra = {}) => postInclude({
    author: profileArgs(),
    parent: profileArgs(),
    comments: fullComments,
    ...extra,
})

const findFullPost = async (id, extra) => shapePost(await prisma.post.findUnique({ where: { id }, include: fullPostInclude(extra) }))


exports.createPost = async (req, res, next) => {
    try {
        let profileId = toId(req.profile._id)
        let caption = req.body.caption
        let thumbnail_url = req.body.photos
        let gallery = req.body.gallery
        let feelings = req.body.feelings
        let location = req.body.location
        let audience = req.body.audience ? parseInt(req.body.audience) : 3
        const { hashtags, mentions } = await extractPostTags(caption)
        if (typeof gallery === 'string') {
            try {
                gallery = JSON.parse(gallery)
            } catch (error) {
                return res.status(400).json({ message: 'Gallery must be a valid JSON array' })
            }
        }
        if (gallery === undefined || gallery === null || gallery === '') gallery = []
        if (!Array.isArray(gallery) || gallery.some((url) => typeof url !== 'string' || !url.trim())) {
            return res.status(400).json({ message: 'Gallery must be an array of image URLs' })
        }

        const savedData = await prisma.post.create({
            data: {
                caption,
                photos: thumbnail_url,
                gallery,
                author: profileId,
                feelings,
                location,
                audience,
                hashtags,
            },
        })
        if (mentions.length) await replaceMentions(savedData.id, mentions)
        enqueueCategorization(savedData.id, 'post')

        const getPost = await findFullPost(savedData.id, { parent: false })
        res.status(200).json({
            message: 'Post Created Successfully',
            post: getPost
        })


    } catch (error) {
        next(error)
    }

}

exports.deletePost = async (req, res, next) => {
    try {
        let profileId = req.profile._id
        let postId = req.body.postId
        let authorId = req.body.authorId;

        if (sameId(profileId, authorId) && isValidId(postId)) {
            const { comments, replies, commentIds } = await deleteCommentsWhere({ post: String(postId) })
            const deletePost = await prisma.post.findUnique({ where: { id: String(postId) } })

            if (deletePost) {
                await removeContent('post', deletePost.id)
                await prisma.$transaction([
                    prisma.cmntReply.deleteMany({ where: { parent: { in: commentIds } } }),
                    prisma.comment.deleteMany({ where: { post: deletePost.id } }),
                ])
                await deleteCloudinaryResources([
                    deletePost.photos,
                    ...(Array.isArray(deletePost.gallery) ? deletePost.gallery : []),
                    ...comments.map((comment) => comment.attachment),
                    ...replies.map((reply) => reply.attachment),
                ])
                res.status(200).json({
                    message: 'Post Deleted Successfully'
                })
            }


        }




    } catch (error) {
        next(error)
    }
}

exports.sharePost = async (req, res, next) => {
    try {
        let profileId = toId(req.profile._id)
        let postId = req.body.postId
        let caption = req.body.caption
        let thePost = isValidId(postId) ? await prisma.post.findUnique({ where: { id: String(postId) } }) : null
        if (!thePost) return res.status(400).json({ message: 'Post Shared Failed' })
        const { hashtags, mentions } = await extractPostTags(caption)

        const savedPost = await prisma.post.create({
            data: {
                caption,
                photos: thePost.photos,
                gallery: Array.isArray(thePost.gallery) ? thePost.gallery : [],
                author: profileId,
                parentPost: thePost.id,
                type: 'share',
                hashtags,
            },
        })
        if (mentions.length) await replaceMentions(savedPost.id, mentions)

        if (savedPost) {
            await prisma.postShare.create({ data: { post: thePost.id, profile: profileId } })
            const getPost = await findFullPost(savedPost.id)
            return res.status(200).json({ message: 'Post Shared Succesfully', post: getPost })
        }


        return res.status(400).json({ message: 'Post Shared Failed' })



    } catch (error) {
        next(error)
    }
}

exports.getMyPosts = async (req, res, next) => {

    try {
        let profile_id = req.query.profile;
        if (req.profile.username == profile_id) {
            profile_id = req.profile._id
        }


        if (!isValidId(profile_id)) return res.json().status(400)
        const posts = await prisma.post.findMany({
            where: { author: toId(profile_id) },
            include: fullPostInclude(),
            orderBy: { createdAt: 'desc' },
        })

        res.status(200).json(posts.map(shapePost))

    } catch (error) {
        next(error)
    }
}

exports.getSinglePost = async (req, res, next) => {

    try {

        let { postId } = req.query
        if (!isValidId(postId)) return

        const post = await findFullPost(String(postId), {
            viewers: { select: { id: true, fullName: true, displayName: true, profilePic: true, username: true, isActive: true } },
        })

        if (post) {
            return res.status(200).json(post)
        }

    } catch (error) {
        console.log(error)
    }
}

exports.updatePost = async (req, res, next) => {
    let { postId, caption, feelings, location, photos, audience, gallery } = req.body
    try {
        let updateData = {}
        let mentions = null

        if (caption !== undefined) {
            updateData.caption = caption
            const tags = await extractPostTags(caption)
            updateData.hashtags = tags.hashtags
            mentions = tags.mentions
        }

        if (feelings !== undefined) {
            updateData.feelings = feelings
        }

        if (location !== undefined) {
            updateData.location = location
        }

        if (photos !== undefined) {
            updateData.photos = photos
        }

        if (gallery !== undefined) {
            if (typeof gallery === 'string') {
                try {
                    gallery = JSON.parse(gallery)
                } catch (error) {
                    return res.status(400).json({ message: 'Gallery must be a valid JSON array' })
                }
            }

            if (!Array.isArray(gallery) || gallery.some((url) => typeof url !== 'string' || !url.trim())) {
                return res.status(400).json({ message: 'Gallery must be an array of image URLs' })
            }

            updateData.gallery = gallery
        }

        if (audience !== undefined) {
            updateData.audience = parseInt(audience, 10)
        }

        const existing = isValidId(postId) ? await prisma.post.findUnique({ where: { id: String(postId) }, select: { id: true } }) : null
        if (!existing) {
            return res.status(404).json({ message: 'Post not found' })
        }
        await prisma.post.update({ where: { id: existing.id }, data: updateData })
        if (mentions) await replaceMentions(existing.id, mentions)
        enqueueCategorization(existing.id, 'post')

        const populatedPost = await findFullPost(existing.id)

        res.status(200).json({
            message: 'Post Updated Successfully',
            post: populatedPost
        })
    } catch (error) {
        next(error)
    }
}


exports.getNewsFeed = async (req, res, next) => {
    let profile = req.profile
    let pageNumber = Number(req.query.pageNumber) || 1
    let limit = 10
    try {
        if (!profile || !profile._id) {
            return res.status(401).json({ message: 'Unauthorized' })
        }

        const currentUserId = toId(profile._id)
        const lists = await audienceLists(profile)

        // Audience values: 1 = Public, 2 = Connects, 3 = Only Me; blocked authors excluded
        const where = audienceWhere(currentUserId, lists)

        const RANK_WINDOW = 40
        const connectIds = new Set(lists.connects.map((id) => String(id)))
        const authorLite = profileArgs(
            ['fullName', 'displayName', 'username', 'nickname', 'profilePic', 'isOfficial', 'isVerified', 'isActive', 'lastActive'],
            ['firstName', 'surname']
        )

        const rankedWindow = (await prisma.post.findMany({
            where,
            include: postInclude({
                author: authorLite,
                parent: authorLite,
                parentSelect: ['caption', 'photos', 'type', 'createdAt'],
            }),
            orderBy: { createdAt: 'desc' },
            take: RANK_WINDOW,
        })).map(shapePost)

        const ranked = rankPosts(rankedWindow, {
            connectIds,
            currentUserId: String(currentUserId),
        })
        const start = (pageNumber - 1) * limit
        const pagePosts = ranked.slice(start, start + limit)

        // populate comments (author + replies) for the page only, as before
        const pageIds = pagePosts.map((post) => post._id)
        const commentRows = pageIds.length ? await prisma.comment.findMany({
            where: { post: { in: pageIds } },
            include: fullComments,
            orderBy: { createdAt: 'asc' },
        }) : []
        const byPost = new Map()
        for (const comment of commentRows) {
            if (!byPost.has(comment.post)) byPost.set(comment.post, [])
            byPost.get(comment.post).push(shapeComment(comment))
        }
        const newsFeedPosts = pagePosts.map((post) => ({ ...post, comments: byPost.get(post._id) || [] }))
        const hasNewPost = start + limit < ranked.length
        res.status(200).json({ posts: newsFeedPosts, hasNewPost })

    } catch (error) {
        console.log(error)
        next(error)
    }
}
