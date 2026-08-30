const Comment = require('../models/Comment')
const Post = require('../models/Post')
const Profile = require('../models/Profile')
const CmntReply = require('../models/CmntReply')
const {saveNotification} = require('./notificationController')
const checkIsActive = require('../utils/checkIsActive')
const { sendPushToProfile } = require('../utils/pushNotifications')
const { getPostId, postLink } = require('../utils/getPostId')
const Story = require('../models/Story')
const Watch = require('../models/Watch')
const mongoose = require('mongoose')

async function resolveCommentParent(parentId) {
    const id = getPostId(parentId)
    if (!id || !mongoose.isValidObjectId(id)) return null

    const story = await Story.findById(id).populate('author')
    if (story) {
        return {
            type: 'story',
            doc: story,
            link: `/story/${id}`,
            id,
        }
    }

    const watch = await Watch.findById(id).populate('author')
    if (watch) {
        return {
            type: 'watch',
            doc: watch,
            link: `/watch/${id}`,
            id,
        }
    }

    const post = await Post.findById(id).populate('author')
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
exports.postAddComment = async (req, res, next) => {
    try {
        let attachment = req.body.attachment ? req.body.attachment : ''
        let body = req.body.body|| ''
        let post = req.body.post || ''
        let watch = req.body.watch || ''
        let profile = req.profile._id|| ''
        let myProfileData = req.profile

        let io = req.app.get('io')

        if (watch && mongoose.isValidObjectId(watch) && mongoose.isValidObjectId(profile)) {
            let commentData = new Comment({
                attachment,
                body,
                author: profile,
                watch,
            })
            let savedCommentData = await commentData.save()

            let updateWatch = await Watch.findOneAndUpdate({
                _id: watch
            }, {
                $push: {
                    comments: savedCommentData._id
                }
            }, { new: true }).populate('author')

            if (updateWatch && updateWatch.author && String(updateWatch.author._id) !== String(profile)) {
                const activeBrowserIds = updateWatch.author.browserIds
                    ?.filter(browser => browser.isActive)
                    ?.map(browser => browser.browserId) || [];

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
                            data: { type: 'watch_comment', watchId: String(watch) }
                        });
                    }
                } catch (e) {}
            }

            const populatedComment = await Comment.findById(savedCommentData._id).populate({
                path: 'author',
                select: ['profilePic', 'user', 'fullName', 'displayName'],
                populate: {
                    path: 'user',
                    select: ['firstName', 'surname']
                }
            });

            return res.json(populatedComment).status(200)
        }


        if(!mongoose.isValidObjectId(post) || !mongoose.isValidObjectId(profile)) {
            return res.json({message: 'Post Comment Failed'}).status(400)
        }
        
        let commentData = new Comment({
            attachment,
            body,
            author: profile,
            post
        })
        let savedCommentData = await commentData.save()

        let updatePost = await Post.findOneAndUpdate({
            _id: post
        }, {
            $push: {
                comments: savedCommentData._id
            }
        }, { new: true }).populate('author')


        if(String(updatePost.author._id) !== String(profile)) {
            // Get all active browser IDs for the post author
            const activeBrowserIds = updatePost.author.browserIds
                ?.filter(browser => browser.isActive)
                ?.map(browser => browser.browserId) || [];

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
                        data: { type: 'post_comment', postId: getPostId(post) }
                    });
                }
            } catch (e) {}
        }


        // Populate the comment with author and user details before returning
        const populatedComment = await Comment.findById(savedCommentData._id).populate({
            path: 'author',
            select: ['profilePic', 'user', 'fullName', 'displayName'],
            populate: {
                path: 'user',
                select: ['firstName', 'surname']
            }
        });

        return res.json(populatedComment).status(200)

    } catch (error) {
        next(error)
    }
}

exports.updateComment = async(req,res,next) => {

    let {commentId, body} = req.body
    try {

        let UpdatedComment = await Comment.findOneAndUpdate({ _id: commentId }, {
            body
        }, { new: true }).populate({
            path: 'author',
            select: ['profilePic', 'user', 'fullName', 'displayName'],
            populate: {
                path: 'user',
                select: ['firstName', 'surname']
            }
        })
        if (UpdatedComment) {
            return res.json(UpdatedComment).status(200)
        }
        return res.json({ message: 'Comment Update Failed' }).status(400)
        
    } catch (error) {
        next(error)
        
    }
}
exports.storyAddComment = async (req, res, next) => {
    try {
        let body = req.body.body
        let storyId = req.body.storyId
        let myProfileData = req.profile
        let profile = myProfileData._id

        let io = req.app.get('io')
        
        let commentData = new Comment({
            body,
            author: profile,
            post: storyId
        })
        let savedCommentData = await commentData.save()

        let updateStory = await Story.findOneAndUpdate({
            _id: storyId
        }, {
            $push: {
                comments: savedCommentData._id
            }
        }, { new: true }).populate('author')

        if(String(updateStory.author._id) !== String(profile)) {
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
                        data: { type: 'story_comment', storyId: String(storyId) }
                    });
                }
            } catch (e) {}
        }

        // Populate the comment with author and user details before returning
        const populatedComment = await Comment.findById(savedCommentData._id).populate({
            path: 'author',
            select: ['profilePic', 'user', 'fullName', 'displayName'],
            populate: {
                path: 'user',
                select: ['firstName', 'surname']
            }
        });

        return res.json(populatedComment)

    } catch (error) {
        next(error)
    }
}

exports.addCommentReact = async (req, res, next) => {
    try {
        let reactorId = req.body.reactorId
        let commentId = req.body.commentId

        if (!reactorId || !commentId) return;
        let updatedComment = await Comment.findOneAndUpdate({
            _id: commentId,
            reacts: {
                $nin: reactorId
            }
        }, {
            $push: {
                reacts: reactorId
            }
        }, { new: true })
        if (updatedComment) {
            // Notify the comment author (if not self)
            try {
                const comment = await Comment.findById(commentId).populate('author');
                const myProfile = req.profile;
                if (comment && comment.author && String(comment.author._id) !== String(myProfile._id)) {
                    const io = req.app.get('io');
                    const parent = await resolveCommentParent(comment.watch || comment.post);
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
        let updatedComment = await Comment.findOneAndUpdate({ _id: commentId }, {
            $pull: {
                reacts: reactorId
            }
        }, { new: true })

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
        let authorId = req.body.authorId
        let replyMsg = req.body.replyMsg
        let myProfileId = req.profile._id
        let myProfile = req.profile
        let io = req.app.get('io')


        if (!commentId || !authorId) {
            return res.status(400).json({ message: 'commentId and authorId are required' });
        }

        let newReplyData = new CmntReply({
            body: replyMsg,
            author: authorId,
            parent: commentId
        })

        let newReply = await newReplyData.save()
        if (newReply !== null) {
            let updateComment = await Comment.findOneAndUpdate({ _id: commentId }, {
                $push: {
                    replies: newReply._id
                }
            }, { new: true })

            if (updateComment) {
                const parent = await resolveCommentParent(updateComment.watch || updateComment.post);
                let newReplyWithAuthor = await CmntReply.findOne({ _id: newReply._id }).populate({
                    path: 'author',
                    select: ['profilePic', 'user', 'fullName', 'displayName'],
                    populate: {
                        path: 'user',
                        select: ['firstName', 'surname']
                    }
                })

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
                        const parentComment = await Comment.findById(commentId).populate('author');
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
        }



        return res.json({ message: 'Something Went Wrong' }).status(400)
    } catch (e) { next(e) }
}

exports.removeCommentReply = async (req, res, next) => {
    try {

        let replyId = req.body.replyId

        let deletedReply = await CmntReply.findOneAndDelete({ _id: replyId })

        if (deletedReply) {

            let pullReplyIdFromCmnt = await Comment.findOneAndUpdate({ _id: deletedReply.parent }, {
                $pull: {
                    replies: deletedReply._id
                }
            })

            if (pullReplyIdFromCmnt) {
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
        let addedReact = await CmntReply.findOneAndUpdate({
            _id: replyId, reacts: {
                $nin: myId
            }
        },{
            $push: {
                reacts: myId
            }
        })

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

        let removedReact = await CmntReply.findOneAndUpdate({_id: replyId},{
            $pull: {
                reacts: myId
            }
        })

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
        let parentId = req.body.postId || req.body.storyId || req.body.watchId
        let parentType = req.body.parentType

        let deleteComment = await Comment.findOneAndDelete({ _id: commentId })
        if (deleteComment) {
            const idToPull = parentId || deleteComment.watch || deleteComment.post

            if (parentType === 'story') {
                await Story.findByIdAndUpdate(idToPull, {
                    $pull: { comments: commentId }
                }, { new: true })
            } else if (parentType === 'watch') {
                await Watch.findByIdAndUpdate(idToPull, {
                    $pull: { comments: commentId }
                }, { new: true })
            } else {
                const updatedPost = await Post.findByIdAndUpdate(idToPull, {
                    $pull: { comments: commentId }
                }, { new: true })

                if (!updatedPost) {
                    const updatedWatch = await Watch.findByIdAndUpdate(idToPull, {
                        $pull: { comments: commentId }
                    }, { new: true })
                    if (!updatedWatch) {
                        await Story.findByIdAndUpdate(idToPull, {
                            $pull: { comments: commentId }
                        }, { new: true })
                    }
                }
            }

            return res.status(200).json({ message: 'Comment Deleted Successfully' })
        }

        return res.status(500).json({ message: 'Comment Deletion Failed' })
    } catch (error) {
        next(error)
    }
}
