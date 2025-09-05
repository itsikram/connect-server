const Comment = require('../models/Comment')
const Post = require('../models/Post')
const Profile = require('../models/Profile')
const CmntReply = require('../models/CmntReply')
const {saveNotification} = require('./notificationController')
const checkIsActive = require('../utils/checkIsActive')
const { sendPushToProfile } = require('../utils/pushNotifications')
const Story = require('../models/Story')
const mongoose = require('mongoose')
exports.postAddComment = async (req, res, next) => {
    try {
        let attachment = req.body.attachment ? req.body.attachment : ''
        let body = req.body.body|| ''
        let post = req.body.post || ''
        let profile = req.profile._id|| ''
        let myProfileData = req.profile

        let io = req.app.get('io')


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
            let notification = {
                receiverId: updatePost.author._id,
                text: `${myProfileData.fullName} Commented in your post`,
                link: '/post/'+post,
                type: 'postComment',
                icon: myProfileData.profilePic
            }

            saveNotification(io, notification)
            try {
                const { isActive } = await checkIsActive(updatePost.author._id)
                if (!isActive) {
                    await sendPushToProfile(updatePost.author._id, {
                        title: 'New comment',
                        body: `${myProfileData.fullName} commented on your post`,
                        data: { type: 'post_comment', postId: String(post) }
                    });
                }
            } catch (e) {}
        }


        return res.json(savedCommentData).status(200)

    } catch (error) {
        next(error)
    }
}

exports.updateComment = async(req,res,next) => {

    let {commentId, body} = req.body
    try {

        let UpdatedComment = await Comment.findOneAndUpdate({ _id: commentId }, {
            body
        }, { new: true })
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
                icon: myProfileData.profilePic
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

        return res.json(savedCommentData)

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
                    const notification = {
                        receiverId: comment.author._id,
                        text: `${myProfile.fullName} liked your comment`,
                        link: '/post/' + String(comment.post),
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
                                data: { type: 'comment_like', postId: String(comment.post), commentId: String(comment._id) }
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
    try {
        let commentId = req.body.commentId
        let authorId = req.body.authorId
        let replyMsg = req.body.replyMsg
        let myProfileId = req.profile._id
        let myProfile = req.profile
        let io = req.app.get('io')


        if (!commentId || !authorId) return next();

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
            },{new: true}).populate([{
                path: 'post',
                model: Post,
                populate: {
                    path: 'author',
                    model: Profile
                }

            }])
            if (updateComment) {
                let newReplyWithAuthor = await CmntReply.findOne({ _id: newReply._id }).populate('author')

                if (newReplyWithAuthor) {

                    if(String(updateComment.post.author._id) !== String(myProfileId)) {
                        let notification = {
                            receiverId: updateComment.post.author._id,
                            text: `${myProfile.fullName} Replied to your comment`,
                            link: '/post/'+(updateComment.post).toString(),
                            type: 'postCommentReply',
                            icon: myProfile.profilePic
                        }
                
                        saveNotification(io, notification)
                        try {
                            const { isActive } = await checkIsActive(updateComment.post.author._id)
                            if (!isActive) {
                                await sendPushToProfile(updateComment.post.author._id, {
                                    title: 'New reply',
                                    body: `${myProfile.fullName} replied to your comment`,
                                    data: { type: 'comment_reply', postId: String(updateComment.post) }
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
                                link: '/post/' + String(updateComment.post),
                                type: 'commentReply',
                                icon: myProfile.profilePic
                            };
                            saveNotification(io, notifForCommentAuthor)
                            try {
                                const { isActive } = await checkIsActive(parentComment.author._id)
                                if (!isActive) {
                                    await sendPushToProfile(parentComment.author._id, {
                                        title: 'New reply',
                                        body: `${myProfile.fullName} replied to your comment`,
                                        data: { type: 'comment_reply', postId: String(updateComment.post), commentId: String(parentComment._id) }
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
        let deleteComment = await Comment.findOneAndDelete({ _id: commentId })
        if (deleteComment) {
            await Post.findByIdAndUpdate({
                _id: commentId
            }, {
                $pull: {
                    comments: commentId
                }
            }, { new: true })

            return res.json({ message: 'Comment Deleted Successfully' }).status(200)
        } else {
            return res.json({ message: 'Comment Deletion Failed' }).status(500)

        }


    } catch (error) {
        next(error)
    }
}
