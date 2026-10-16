// Prisma include / reshape helpers for posts, watches, stories and comments.
// The MySQL schema keeps reacts / shares / viewers / seenBy in join tables and
// comments point at their parent; these helpers rebuild the Mongo document
// shape (reacts: [{ _id, profile, type }], shares: [profileId], comments: [...],
// aiMetadata: {...}) that the web and Expo clients read.
const { Prisma } = require('@prisma/client')
const { prisma, populated, pluck, jsonArray, jsonObject, toId } = require('../utils/db')

// Never send these when a user row is populated onto a profile.
const USER_OMIT = { password: true, resetPasswordToken: true, resetPasswordExpire: true }

const select = (...fields) => Object.fromEntries(['id', ...fields].map((field) => [field, true]))

/** Profile include: full profile (+ user) or a select list (+ user select list). */
const profileArgs = (profileFields, userFields) => {
    const userDoc = userFields ? { select: select(...userFields) } : { omit: USER_OMIT }
    if (!profileFields) return { include: { userDoc } }
    return { select: { ...select(...profileFields), user: true, userDoc } }
}

const shapeProfile = (profile) => {
    if (!profile) return profile
    populated(profile, 'user')
    return profile
}

const COMMENT_AUTHOR = profileArgs(
    ['profilePic', 'fullName', 'displayName', 'username', 'nickname'],
    ['firstName', 'surname']
)

/** Comment include: author + replies (each with author). */
const commentInclude = (author = COMMENT_AUTHOR, replyAuthor = author, withReplies = true) => ({
    authorDoc: author,
    replies: withReplies
        ? { orderBy: { createdAt: 'asc' }, include: { authorDoc: replyAuthor } }
        : { orderBy: { createdAt: 'asc' }, select: { id: true } },
})

const shapeReply = (reply) => {
    if (!reply) return reply
    if ('authorDoc' in reply) {
        populated(reply, 'author')
        shapeProfile(reply.author)
    }
    reply.reacts = jsonArray(reply.reacts)
    return reply
}

const shapeComment = (comment) => {
    if (!comment) return comment
    if ('authorDoc' in comment) {
        populated(comment, 'author')
        shapeProfile(comment.author)
    }
    if (Array.isArray(comment.replies)) {
        comment.replies = comment.replies.map((reply) => (reply && typeof reply === 'object' && 'body' in reply ? shapeReply(reply) : toId(reply)))
    } else {
        comment.replies = []
    }
    comment.reacts = jsonArray(comment.reacts)
    return comment
}

/** Comments relation: full objects (with include) or just ids. */
const commentsArgs = (include, extra = {}) => include
    ? { orderBy: { createdAt: 'asc' }, include, ...extra }
    : { orderBy: { createdAt: 'asc' }, select: { id: true }, ...extra }

const reactRows = { orderBy: { createdAt: 'asc' }, select: { id: true, profile: true, type: true } }
const idRows = { orderBy: { createdAt: 'asc' }, select: { id: true, profile: true } }

/**
 * Post include.
 * author: profileArgs(...) | false, comments: commentInclude(...) | false (ids only),
 * parent: profileArgs for the shared post's author | false, viewers: profileArgs | false (ids)
 */
const postInclude = ({ author = profileArgs(), comments = false, commentsExtra, parent = false, parentSelect, viewers = false } = {}) => ({
    ...(author ? { authorDoc: author } : {}),
    ...(parent ? {
        parentPostDoc: parentSelect
            ? { select: { ...select(...parentSelect), author: true, authorDoc: parent } }
            : { include: { authorDoc: parent, reacts: reactRows, shares: idRows, comments: { select: { id: true } } } },
    } : {}),
    reacts: reactRows,
    shares: idRows,
    mentions: idRows,
    viewers: viewers ? { orderBy: { createdAt: 'asc' }, select: { id: true, profile: true, profileDoc: viewers } } : idRows,
    comments: commentsArgs(comments, commentsExtra),
})

const watchInclude = ({ author = profileArgs(), comments = false, commentsExtra } = {}) => ({
    ...(author ? { authorDoc: author } : {}),
    reacts: reactRows,
    shares: idRows,
    comments: commentsArgs(comments, commentsExtra),
})

const storyInclude = ({ author = profileArgs(), comments = false } = {}) => ({
    ...(author ? { authorDoc: author } : {}),
    reacts: reactRows,
    seenBy: idRows,
    comments: commentsArgs(comments),
})

const AI_FIELDS = {
    aiStatus: 'status',
    aiCategories: 'categories',
    aiEmbedding: 'embedding',
    aiEmbeddingModel: 'embeddingModel',
    aiProvider: 'provider',
    aiContentHash: 'contentHash',
    aiSentiment: 'sentiment',
    aiContentSafetyFlags: 'contentSafetyFlags',
    aiProcessedAt: 'processedAt',
    aiError: 'error',
}

/** Move the flattened ai* columns back into an `aiMetadata` object. */
const withAiMetadata = (row) => {
    if (!row || !Object.keys(AI_FIELDS).some((key) => key in row)) return row
    const meta = {}
    for (const [column, key] of Object.entries(AI_FIELDS)) {
        if (!(column in row)) continue
        const value = row[column]
        delete row[column]
        if (value === null || value === undefined) continue
        meta[key] = value
    }
    meta.categories = jsonArray(meta.categories)
    meta.contentSafetyFlags = jsonArray(meta.contentSafetyFlags)
    if (!Array.isArray(meta.embedding)) delete meta.embedding
    row.aiMetadata = meta
    return row
}

const JSON_AI_FIELDS = new Set(['aiCategories', 'aiEmbedding', 'aiContentSafetyFlags'])

/** aiMetadata object (categorizeContent result) -> ai* column data. */
const aiMetadataData = (meta = {}) => {
    const data = {}
    for (const [column, key] of Object.entries(AI_FIELDS)) {
        if (!(key in meta)) continue
        const value = meta[key] ?? null
        data[column] = value === null && JSON_AI_FIELDS.has(column) ? Prisma.DbNull : value
    }
    return data
}

const shapeReacts = (rows) => (Array.isArray(rows) ? rows.map((row) => ({ _id: row.id, profile: row.profile, type: row.type })) : [])

const shapeComments = (comments) => (Array.isArray(comments)
    ? comments.map((comment) => ('body' in comment || 'authorDoc' in comment ? shapeComment(comment) : comment.id))
    : [])

const shapeCommon = (row) => {
    if ('authorDoc' in row) {
        populated(row, 'author')
        shapeProfile(row.author)
    }
    if ('reacts' in row) row.reacts = shapeReacts(row.reacts)
    if ('shares' in row) row.shares = pluck(row.shares, 'profile')
    if ('comments' in row) row.comments = shapeComments(row.comments)
    withAiMetadata(row)
    return row
}

const shapePost = (post) => {
    if (!post) return post
    shapeCommon(post)
    if ('parentPostDoc' in post) {
        populated(post, 'parentPost')
        if (post.parentPost) shapePost(post.parentPost)
    }
    if ('mentions' in post) post.mentions = pluck(post.mentions, 'profile')
    if ('viewers' in post) {
        post.viewers = post.viewers.map((row) => ('profileDoc' in row ? row.profileDoc : row.profile)).filter(Boolean)
    }
    if ('hashtags' in post) post.hashtags = jsonArray(post.hashtags)
    if ('gallery' in post) post.gallery = jsonArray(post.gallery)
    return post
}

const shapeWatch = (watch) => (watch ? shapeCommon(watch) : watch)

const shapeStory = (story) => {
    if (!story) return story
    shapeCommon(story)
    if ('seenBy' in story) story.seenBy = pluck(story.seenBy, 'profile')
    return story
}

/** Connect / blocked id lists for a profile (req.profile may be a Mongoose doc or a Prisma row). */
const audienceLists = async (profile) => {
    const id = toId(profile)
    const listOf = (value) => (Array.isArray(value) ? value.map((item) => toId(item?.connect ?? item?.blocked ?? item)).filter(Boolean) : null)
    let connects = listOf(profile?.connects)
    let blocked = listOf(profile?.blockedUsers)
    if (!connects && id) connects = pluck(await prisma.profileConnect.findMany({ where: { profile: id }, select: { connect: true } }), 'connect')
    if (!blocked && id) blocked = pluck(await prisma.block.findMany({ where: { profile: id }, select: { blocked: true } }), 'blocked')
    return { connects: connects || [], blocked: blocked || [] }
}

/** Prisma where for audience rules: 1 = public, 2 = connects, 3 = only me; blocked authors excluded. */
const audienceWhere = (profileId, { connects = [], blocked = [] } = {}) => ({
    AND: [
        { OR: [{ audience: 1 }, { audience: 2, author: { in: connects } }, { audience: 3, author: String(profileId) }] },
        ...(blocked.length ? [{ OR: [{ author: null }, { author: { notIn: blocked } }] }] : []),
    ],
})

const publicWhere = ({ blocked = [] } = {}) => ({
    AND: [
        { audience: 1 },
        ...(blocked.length ? [{ OR: [{ author: null }, { author: { notIn: blocked } }] }] : []),
    ],
})

/** Collect a parent's comments and their replies (for delete + Cloudinary cleanup). */
const deleteCommentsWhere = async (where) => {
    const comments = await prisma.comment.findMany({ where, select: { id: true, attachment: true } })
    const commentIds = comments.map((comment) => comment.id)
    const replies = commentIds.length
        ? await prisma.cmntReply.findMany({ where: { parent: { in: commentIds } }, select: { attachment: true } })
        : []
    return { comments, replies, commentIds }
}

/**
 * Delete a post / watch / story row with its join rows. Raw DELETE for the row
 * itself: relationMode "prisma" emulates NoAction as restrict, which would block
 * deleting a post that was shared or reported (Mongo left those refs dangling).
 */
const removeContent = async (kind, id) => {
    id = String(id)
    if (kind === 'post') {
        await prisma.$transaction([
            prisma.postReact.deleteMany({ where: { post: id } }),
            prisma.postShare.deleteMany({ where: { post: id } }),
            prisma.postViewer.deleteMany({ where: { post: id } }),
            prisma.postMention.deleteMany({ where: { post: id } }),
            prisma.$executeRaw`DELETE FROM posts WHERE id = ${id}`,
        ])
    } else if (kind === 'watch') {
        await prisma.$transaction([
            prisma.watchReact.deleteMany({ where: { watch: id } }),
            prisma.watchShare.deleteMany({ where: { watch: id } }),
            prisma.$executeRaw`DELETE FROM watches WHERE id = ${id}`,
        ])
    } else if (kind === 'story') {
        await prisma.$transaction([
            prisma.storyReact.deleteMany({ where: { story: id } }),
            prisma.storySeen.deleteMany({ where: { story: id } }),
            prisma.$executeRaw`DELETE FROM stories WHERE id = ${id}`,
        ])
    }
}

module.exports = {
    removeContent,
    USER_OMIT,
    profileArgs,
    shapeProfile,
    COMMENT_AUTHOR,
    commentInclude,
    shapeComment,
    shapeReply,
    postInclude,
    watchInclude,
    storyInclude,
    shapePost,
    shapeWatch,
    shapeStory,
    withAiMetadata,
    aiMetadataData,
    audienceLists,
    audienceWhere,
    publicWhere,
    deleteCommentsWhere,
}
