const { prisma, isValidId, toId, populated, jsonArray } = require('../utils/db')
const {saveNotification} = require('./notificationController')
const checkIsActive = require('../utils/checkIsActive')
const { sendPushToProfile } = require('../utils/pushNotifications')
const { getPostId, postLink } = require('../utils/getPostId')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')
const { profileArgs, shapeComment, shapeReply } = require('../services/contentShape')

// author: profilePic, user, fullName, displayName (+ user firstName, surname)
const commentAuthor = profileArgs(['profilePic', 'fullName', 'displayName'], ['firstName', 'surname'])

// Comment in the old shape: author populated, replies as ids.
const findCommentWithAuthor = async (id) => shapeComment(await prisma.comment.findUnique({
    where: { id },
    include: { authorDoc: commentAuthor, replies: { orderBy: { createdAt: 'asc' }, select: { id: true } } },
}))

const findReplyWithAuthor = async (id) => shapeReply(await prisma.cmntReply.findUnique({
    where: { id },
    include: { authorDoc: commentAuthor },
}))

// Parent document with its author profile populated (Mongoose .populate('author')).
const loadWithAuthor = async (model, id) => {
    const row = await prisma[model].findUnique({ where: { id }, include: { authorDoc: true } })
    return row ? populated(row, 'author') : null
}

async function resolveCommentParent(parentId) {
    const id = getPostId(parentId)
    if (!id || !isValidId(id)) return null

    const story = await loadWithAuthor('story', id)
    if (story) {
        return {
            type: 'story',
            doc: story,
            link: `/story/${id}`,
            id,
        }
    }

    const watch = await loadWithAuthor('watch', id)
    if (watch) {
        return {
            type: 'watch',
            doc: watch,
            link: `/watch/${id}`,
            id,
        }
    }

    const post = await loadWithAuthor('post', id)
    if (post) {
        return {
            type: 'post',
            doc: post,
            link: postLink(post),
            id,
        }
    }

    return null
}

const commentParentId = (comment) => comment?.post || comment?.watch || comment?.story

const sameProfile = (left, right) => String(left?._id || left) === String(right?._id || right)

async function canDeleteComment(profileId, comment) {
    if (sameProfile(comment.author, profileId)) return true
    const parent = await resolveCommentParent(commentParentId(comment))
    return Boolean(parent?.type === 'post' && parent.doc?.author && sameProfile(parent.doc.author, profileId))
}

async function canDeleteReply(profileId, reply) {
    if (sameProfile(reply.author, profileId)) return true
    const parentComment = await prisma.comment.findUnique({ where: { id: reply.parent }, select: { id: true, post: true, watch: true, story: true } })
    if (!parentComment) return false
    const parent = await resolveCommentParent(commentParentId(parentComment))
    return Boolean(parent?.type === 'post' && parent.doc?.author && sameProfile(parent.doc.author, profileId))
}

const activeBrowserIdsOf = (profile) => jsonArray(profile?.browserIds)
    .filter(browser => browser?.isActive)
    .map(browser => browser.browserId)

exports.postAddComment = async (req, res, next) => {
    try {
        let attachment = req.body.attachment ? req.body.attachment : ''
        let body = req.body.body|| ''
        let post = req.body.post || ''
        let watch = req.body.watch || ''
        let profile = toId(req.profile._id) || ''
        let myProfileData = req.profile

        let io = req.app.get('io')

        if (watch && isValidId(watch) && isValidId(profile)) {
            watch = String(watch)
            let savedCommentData = await prisma.comment.create({
                data: {
                    attachment,
                    body,
                    author: profile,
                    watch,
                    reacts: [],
                }
            })

            let updateWatch = await loadWithAuthor('watch', watch)

            if (updateWatch && updateWatch.author && String(updateWatch.author._id) !== String(profile)) {
                const activeBrowserIds = activeBrowserIdsOf(updateWatch.author);

                let notification = {
                    receiverId: updateWatch.author._id,
                    text: `${myProfileData.fullName} Commented on your video`,
                    link: '/watch/' + watch,
                    type: 'postComment',
                    icon: myProfileData.profilePic,
                    browserIds: activeBrowserIds,
                    data: {
                        senderId: profile,
                        senderName: myProfileData.fullName,
                        senderProfilePic: myProfileData.profilePic,
                        watchId: watch,
                        commentId: savedCommentData._id,
                        commentBody: body
                    }
                }

                saveNotification(io, notification)
                io.to(updateWatch.author._id).emit('postCommentNotification', {
                    senderName: myProfileData.fullName,
                    senderPP: myProfileData.profilePic,
                    watchId: watch,
                    commentBody: body
                })

                try {
                    const { isActive } = await checkIsActive(updateWatch.author._id)
                    if (!isActive) {
                        await sendPushToProfile(updateWatch.author._id, {
                            title: 'New comment',
                            body: `${myProfileData.fullName} commented on your video`,
                            image: myProfileData.profilePic,
                            data: { type: 'watch_comment', watchId: String(watch) }
                        });
                    }
                } catch (e) {}
            }

            const populatedComment = await findCommentWithAuthor(savedCommentData.id);

            return res.json(populatedComment).status(200)
        }


        if(!isValidId(post) || !isValidId(profile)) {
            return res.json({message: 'Post Comment Failed'}).status(400)
        }
        post = String(post)

        let savedCommentData = await prisma.comment.create({
            data: {
                attachment,
                body,
                author: profile,
                post,
                reacts: [],
            }
        })

        let updatePost = await loadWithAuthor('post', post)


        if(updatePost?.author && String(updatePost.author._id) !== String(profile)) {
            // Get all active browser IDs for the post author
            const activeBrowserIds = activeBrowserIdsOf(updatePost.author);

            let notification = {
                receiverId: updatePost.author._id,
                text: `${myProfileData.fullName} Commented in your post`,
                link: postLink(post),
                type: 'postComment',
                icon: myProfileData.profilePic,
                browserIds: activeBrowserIds,
                data: {
                    senderId: profile,
                    senderName: myProfileData.fullName,
                    senderProfilePic: myProfileData.profilePic,
                    postId: getPostId(post),
                    commentId: savedCommentData._id,
                    commentBody: body
                }
            }

            saveNotification(io, notification)

            // Also emit specific socket event for post comment
            io.to(updatePost.author._id).emit('postCommentNotification', {
                senderName: myProfileData.fullName,
                senderPP: myProfileData.profilePic,
                postId: post,
                commentBody: body
            })

            try {
                const { isActive } = await checkIsActive(updatePost.author._id)
                if (!isActive) {
                    await sendPushToProfile(updatePost.author._id, {
                        title: 'New comment',
                        body: `${myProfileData.fullName} commented on your post`,
                        image: myProfileData.profilePic,
                        data: { type: 'post_comment', postId: getPostId(post) }
                    });
                }
            } catch (e) {}
        }


        // Populate the comment with author and user details before returning
        const populatedComment = await findCommentWithAuthor(savedCommentData.id);

        return res.json(populatedComment).status(200)

    } catch (error) {
        next(error)
    }
}

exports.updateComment = async(req,res,next) => {

    let {commentId, body} = req.body
    try {

        const { count } = isValidId(commentId)
            ? await prisma.comment.updateMany({ where: { id: String(commentId), author: toId(req.profile._id) }, data: { body } })
            : { count: 0 }
        if (count) {
            return res.json(await findCommentWithAuthor(String(commentId))).status(200)
        }
        return res.json({ message: 'Comment Update Failed' }).status(400)

    } catch (error) {
        next(error)

    }
}

exports.updateCommentReply = async (req, res, next) => {
    const { replyId, body } = req.body
    try {
        const { count } = isValidId(replyId)
            ? await prisma.cmntReply.updateMany({ where: { id: String(replyId), author: toId(req.profile._id) }, data: { body } })
            : { count: 0 }

        if (count) return res.status(200).json(await findReplyWithAuthor(String(replyId)))
        return res.status(403).json({ message: 'Reply update is not allowed' })
    } catch (error) {
        next(error)
    }
}

exports.storyAddComment = async (req, res, next) => {
    try {
        let body = req.body.body
        let storyId = req.body.storyId
        let myProfileData = req.profile
        let profile = toId(myProfileData._id)

        let io = req.app.get('io')

        if (!isValidId(storyId)) throw new Error('Invalid story id')
        storyId = String(storyId)

        let savedCommentData = await prisma.comment.create({
            data: {
                body,
                author: profile,
                story: storyId,
                reacts: [],
            }
        })

        let updateStory = await loadWithAuthor('story', storyId)

        if(updateStory?.author && String(updateStory.author._id) !== String(profile)) {
            let notification = {
                receiverId: updateStory.author._id,
                text: `${myProfileData.fullName} Commented in your Story`,
                link: '/story/'+storyId,
                type: 'storyComment',
                icon: myProfileData.profilePic,
                data: {
                    commentBody: body,
                    storyId,
                    senderId: profile,
                    senderName: myProfileData.fullName,
                }
            }

            saveNotification(io, notification)
            try {
                const { isActive } = await checkIsActive(updateStory.author._id)
                if (!isActive) {
                    await sendPushToProfile(updateStory.author._id, {
                        title: 'New comment',
                        body: `${myProfileData.fullName} commented on your story`,
                        image: myProfileData.profilePic,
                        data: { type: 'story_comment', storyId: String(storyId) }
                    });
                }
            } catch (e) {}
        }

        // Populate the comment with author and user details before returning
        const populatedComment = await findCommentWithAuthor(savedCommentData.id);

        return res.json(populatedComment)

    } catch (error) {
        next(error)
    }
}

// Comment / reply reacts are a Json array of reactor ids.
const addReactor = async (model, id, reactorId) => {
    if (!isValidId(id) || !reactorId) return false
    const row = await prisma[model].findUnique({ where: { id: String(id) }, select: { id: true, reacts: true } })
    if (!row) return false
    const reacts = jsonArray(row.reacts)
    if (reacts.some((react) => String(react) === String(reactorId))) return false
    await prisma[model].update({ where: { id: row.id }, data: { reacts: [...reacts, reactorId] } })
    return true
}

const removeReactor = async (model, id, reactorId) => {
    if (!isValidId(id)) return false
    const row = await prisma[model].findUnique({ where: { id: String(id) }, select: { id: true, reacts: true } })
    if (!row) return false
    const reacts = jsonArray(row.reacts)
    await prisma[model].update({ where: { id: row.id }, data: { reacts: reacts.filter((react) => String(react) !== String(reactorId)) } })
    return true
}

exports.addCommentReact = async (req, res, next) => {
    try {
        let reactorId = req.body.reactorId
        let commentId = req.body.commentId

        if (!reactorId || !commentId) return;
        let updatedComment = await addReactor('comment', commentId, reactorId)
        if (updatedComment) {
            // Notify the comment author (if not self)
            try {
                const comment = await loadWithAuthor('comment', String(commentId));
                const myProfile = req.profile;
                if (comment && comment.author && String(comment.author._id) !== String(myProfile._id)) {
                    const io = req.app.get('io');
                    const parent = await resolveCommentParent(comment.watch || comment.story || comment.post);
                    const notification = {
                        receiverId: comment.author._id,
                        text: `${myProfile.fullName} liked your comment`,
                        link: parent?.link || postLink(comment.post),
                        type: 'commentReact',
                        icon: myProfile.profilePic
                    };
                    saveNotification(io, notification);
                    try {
                        const { isActive } = await checkIsActive(comment.author._id)
                        if (!isActive) {
                            await sendPushToProfile(comment.author._id, {
                                title: 'Comment liked',
                                body: `${myProfile.fullName} liked your comment`,
                                image: myProfile.profilePic,
                                data: {
                                    type: 'comment_like',
                                    postId: parent?.id || getPostId(comment.post),
                                    commentId: String(comment._id),
                                    ...(parent?.type === 'story' ? { storyId: parent.id } : {}),
                                }
                            });
                        }
                    } catch (e) {}
                }
            } catch (e) { }

            return res.json({ messasge: 'Comment Reacted Successfully' }).status(200)
        }
        return res.json({ messasge: 'Comment Cannot Be Reacted' }).status(400)

    }
    catch (e) { next(e) }
}

exports.removeCommentReact = async (req, res, next) => {
    try {
        let reactorId = req.body.reactorId
        let commentId = req.body.commentId
        let updatedComment = await removeReactor('comment', commentId, reactorId)

        if (updatedComment) {
            return res.json({ messasge: 'Comment React Removed Successfully' }).status(200)
        }
        return res.json({ messasge: 'Comment React Cannot Be Removed' }).status(400)

    }
    catch (e) { next(e) }
}

exports.postCommentReply = async (req, res, next) => {

    console.log('add comment')
    try {
        let commentId = req.body.commentId
        let authorId = toId(req.profile._id)
        let replyMsg = req.body.replyMsg
        let myProfileId = authorId
        let myProfile = req.profile
        let io = req.app.get('io')


        if (!commentId || !authorId) {
            return res.status(400).json({ message: 'commentId and authorId are required' });
        }

        let updateComment = isValidId(commentId)
            ? await prisma.comment.findUnique({ where: { id: String(commentId) } })
            : null

        if (updateComment) {
            const newReply = await prisma.cmntReply.create({
                data: {
                    body: replyMsg,
                    author: authorId,
                    parent: updateComment.id,
                    reacts: [],
                }
            })

            const parent = await resolveCommentParent(commentParentId(updateComment));
            let newReplyWithAuthor = await findReplyWithAuthor(newReply.id)

            if (newReplyWithAuthor && parent?.doc?.author) {

                if (String(parent.doc.author._id) !== String(myProfileId)) {
                    let notification = {
                        receiverId: parent.doc.author._id,
                        text: `${myProfile.fullName} Replied to your comment`,
                        link: parent.link,
                        type: parent.type === 'story' ? 'storyCommentReply' : 'postCommentReply',
                        icon: myProfile.profilePic,
                        data: {
                            replyMsg,
                            commentId,
                            senderId: myProfileId,
                            senderName: myProfile.fullName,
                            ...(parent.type === 'story'
                                ? { storyId: parent.id }
                                : { postId: parent.id }),
                        }
                    }

                    saveNotification(io, notification)
                    try {
                        const { isActive } = await checkIsActive(parent.doc.author._id)
                        if (!isActive) {
                            await sendPushToProfile(parent.doc.author._id, {
                                title: 'New reply',
                                body: `${myProfile.fullName} replied to your comment`,
                                image: myProfile.profilePic,
                                data: {
                                    type: 'comment_reply',
                                    ...(parent.type === 'story'
                                        ? { storyId: parent.id }
                                        : { postId: parent.id }),
                                }
                            });
                        }
                    } catch (e) {}
                }

                // Also notify the original comment author (if different from replier)
                try {
                    const parentComment = await loadWithAuthor('comment', updateComment.id);
                    if (parentComment && String(parentComment.author._id) !== String(myProfileId)) {
                        const notifForCommentAuthor = {
                            receiverId: parentComment.author._id,
                            text: `${myProfile.fullName} replied to your comment`,
                            link: parent.link,
                            type: 'commentReply',
                            icon: myProfile.profilePic,
                            data: {
                                replyMsg,
                                commentId,
                                senderId: myProfileId,
                                senderName: myProfile.fullName,
                                ...(parent.type === 'story'
                                    ? { storyId: parent.id }
                                    : { postId: parent.id }),
                            }
                        };
                        saveNotification(io, notifForCommentAuthor)
                        try {
                            const { isActive } = await checkIsActive(parentComment.author._id)
                            if (!isActive) {
                                await sendPushToProfile(parentComment.author._id, {
                                    title: 'New reply',
                                    body: `${myProfile.fullName} replied to your comment`,
                                    image: myProfile.profilePic,
                                    data: {
                                        type: 'comment_reply',
                                        commentId: String(parentComment._id),
                                        ...(parent.type === 'story'
                                            ? { storyId: parent.id }
                                            : { postId: parent.id }),
                                    }
                                });
                            }
                        } catch (e) {}
                    }
                } catch (e) {}

                return res.json(newReplyWithAuthor).status(200)

            }
        }



        return res.json({ message: 'Something Went Wrong' }).status(400)
    } catch (e) { next(e) }
}

exports.removeCommentReply = async (req, res, next) => {
    try {

        let replyId = req.body.replyId
        let reply = isValidId(replyId) ? await prisma.cmntReply.findUnique({ where: { id: String(replyId) } }) : null
        if (!reply) {
            return res.status(400).json({ message: 'Comment Reply Deletion Failed' })
        }
        if (!await canDeleteReply(req.profile._id, reply)) {
            return res.status(403).json({ message: 'You are not allowed to delete this reply' })
        }

        const { count } = await prisma.cmntReply.deleteMany({ where: { id: reply.id } })

        if (count) {
            await deleteCloudinaryResources([reply.attachment])

            const parentComment = await prisma.comment.findUnique({ where: { id: reply.parent }, select: { id: true } })

            if (parentComment) {
                return res.json({ message: 'Comment Reply Deleted Successfully' }).status(200)

            }
        }
        return res.json({ message: 'Comment Reply Deletion Failed' }).status(400)


    } catch (e) { next(e) }
}

exports.addReplyReact = async (req, res, next) => {
    let replyId = req.body.replyId
    let myId = req.body.myId
    try {
        let addedReact = await addReactor('cmntReply', replyId, myId)

        if(addedReact) {
            return res.json({message: 'Reply React added sucessfully'}).status(200)
        }

        return res.json({message: 'Reply React Cannot be added'})
    } catch (e) { next(e) }

}
exports.removeReplyReact = async (req, res, next) => {
    let replyId = req.body.replyId
    let myId = req.body.myId
    try {

        let removedReact = await removeReactor('cmntReply', replyId, myId)

        if(removedReact) {
            return res.json({message: 'Reply React Removed Sucessfully'}).status(200)
        }
        return res.json({message: 'Reply React cannot be removed'}).status(400)

    } catch (error) {
        next(error)
    }
}

exports.postDeleteComment = async (req, res, next) => {
    try {
        let commentId = req.body.commentId

        const comment = isValidId(commentId) ? await prisma.comment.findUnique({ where: { id: String(commentId) } }) : null
        if (!comment) {
            return res.status(500).json({ message: 'Comment Deletion Failed' })
        }
        if (!await canDeleteComment(req.profile._id, comment)) {
            return res.status(403).json({ message: 'You are not allowed to delete this comment' })
        }

        // The comment points at its parent, so removing it also removes it from the post / watch / story.
        const replies = await prisma.cmntReply.findMany({ where: { parent: comment.id }, select: { attachment: true } })
        const [, deleted] = await prisma.$transaction([
            prisma.cmntReply.deleteMany({ where: { parent: comment.id } }),
            prisma.comment.deleteMany({ where: { id: comment.id } }),
        ])
        if (deleted.count) {
            await deleteCloudinaryResources([comment.attachment])
            await deleteCloudinaryResources(replies.map((reply) => reply.attachment))

            return res.status(200).json({ message: 'Comment Deleted Successfully' })
        }

        return res.status(500).json({ message: 'Comment Deletion Failed' })
    } catch (error) {
        next(error)
    }
}
