const Post = require('../models/Post')
const Profile = require('../models/Profile')
const User = require('../models/User')
const Comment = require('../models/Comment')
const jwt = require('jsonwebtoken')
const CmntReply = require('../models/CmntReply')
const mongoose = require('mongoose')
const { rankPosts } = require('../utils/feedRanking')
const { enqueueCategorization } = require('../services/contentCategorizationQueue')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')

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
        if (mongoose.isValidObjectId(mentionMatch[1])) mentionIds.add(mentionMatch[1])
    }
    mentionTokenPattern.lastIndex = 0

    const usernames = []
    const usernamePattern = /(^|[^\p{L}\p{N}_])@([a-zA-Z0-9_.-]{3,50})/gu
    let usernameMatch
    while ((usernameMatch = usernamePattern.exec(text))) usernames.push(usernameMatch[2])
    if (usernames.length) {
        const profiles = await Profile.find({ username: { $in: usernames } }).select('_id').lean()
        profiles.forEach((profile) => mentionIds.add(String(profile._id)))
    }

    return { hashtags: [...hashtags], mentions: [...mentionIds] }
}

const commentAuthorPopulate = {
    path: 'author',
    model: Profile,
    select: 'profilePic user fullName displayName username nickname',
    populate: {
        path: 'user',
        select: 'firstName surname displayName fullName'
    }
}

const commentReplyPopulate = {
    path: 'replies',
    model: CmntReply,
    populate: commentAuthorPopulate
}

const commentPopulate = {
    path: 'comments',
    model: Comment,
    populate: [commentAuthorPopulate, commentReplyPopulate]
}


exports.createPost = async (req, res, next) => {
    try {
        let profileId = req.profile._id
        let caption = req.body.caption
        let thumbnail_url = req.body.photos
        let gallery = req.body.gallery
        let feelings = req.body.feelings
        let location = req.body.location
        let audience = req.body.audience ? parseInt(req.body.audience) : 3
        const tags = await extractPostTags(caption)
        // return console.log(req.body)
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

        let post = new Post({
            caption,
            photos: thumbnail_url,
            gallery,
            author: profileId,
            feelings,
            location,
            audience,
            ...tags

        })

        let savedData = await post.save()
        enqueueCategorization(savedData._id, 'post')

        let getPost = await Post.findOne({ _id: savedData._id }).populate([
            {
                path: 'author',
                model: Profile,
                populate: {
                    path: 'user'
                }
            },
            {
                path: 'comments',
                model: Comment,
                populate: [commentAuthorPopulate, commentReplyPopulate]
            }]).sort({ 'createdAt': -1 })
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

        if (profileId == authorId) {
            const comments = await Comment.find({ post: postId }).select('attachment replies')
            const replies = await CmntReply.find({ parent: { $in: comments.map((comment) => comment._id) } }).select('attachment')
            let deletePost = await Post.findOneAndDelete({ _id: postId })

            if (deletePost) {
                await Promise.all([
                    Comment.deleteMany({ post: postId }),
                    CmntReply.deleteMany({ parent: { $in: comments.map((comment) => comment._id) } }),
                ])
                await deleteCloudinaryResources([
                    deletePost.photos,
                    ...(deletePost.gallery || []),
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
        let profileId = req.profile._id
        let postId = req.body.postId
        let caption = req.body.caption
        let thePost = await Post.findOne({ _id: postId })
        const tags = await extractPostTags(caption)

        let sharedPost = new Post({
            caption,
            photos: thePost.photos,
            gallery: thePost.gallery || [],
            author: profileId,
            parentPost: thePost._id,
            type: 'share',
            ...tags
        })

        let savedPost = await sharedPost.save();

        if (savedPost) {
            let updatePost = await Post.findOneAndUpdate({ _id: postId }, {
                $push: {
                    shares: profileId
                }
            })

            let getPost = await Post.findOne({ _id: savedPost._id }).populate([
                {
                    path: 'author',
                    model: Profile,
                    populate: {
                        path: 'user'
                    }
                },
                {
                    path: 'parentPost',
                    model: Post,
                    populate: [{
                        path: 'author',
                        model: Profile
                    }, {
                        path: 'author.user'
                    }]
                },
                {
                    path: 'comments',
                    model: Comment,
                    populate: [commentAuthorPopulate, commentReplyPopulate]
                }]).sort({ 'createdAt': -1 })
            if (updatePost) {
                return res.status(200).json({ message: 'Post Shared Succesfully', post: getPost })

            }
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


        if (!mongoose.isValidObjectId(profile_id)) return res.json().status(400)
        let posts = await Post.find({ author: profile_id }).populate([
            {
                path: 'author',
                model: Profile,
                populate: {
                    path: 'user'
                }
            },
            {
                path: 'parentPost',
                model: Post,
                populate: [{
                    path: 'author',
                    model: Profile
                }, {
                    path: 'author.user'
                }]
            },
            {
                path: 'comments',
                model: Comment,
                populate: [commentAuthorPopulate, commentReplyPopulate]
            }]).sort({ 'createdAt': -1 })

        res.status(200).json(posts)

    } catch (error) {
        next(error)
    }
}

exports.getSinglePost = async (req, res, next) => {

    try {

        let { postId } = req.query

        let post = await Post.findOne({ _id: postId }).populate([
            {
                path: 'author',
                model: Profile,
                populate: {
                    path: 'user'
                }
            },
            {
                path: 'parentPost',
                model: Post,
                populate: [{
                    path: 'author',
                    model: Profile
                }, {
                    path: 'author.user'
                }]
            },
            {
                path: 'comments',
                model: Comment,
                populate: [commentAuthorPopulate, commentReplyPopulate]
            },
            {
                path: 'viewers',
                model: Profile,
                select: 'fullName displayName profilePic username isActive',
            }

        ])

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

        if (caption !== undefined) {
            updateData.caption = caption
            Object.assign(updateData, await extractPostTags(caption))
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
            updateData.audience = audience
        }

        let updatedPost = await Post.findOneAndUpdate({ _id: postId }, updateData, { new: true })

        if (!updatedPost) {
            return res.status(404).json({ message: 'Post not found' })
        }
        enqueueCategorization(updatedPost._id, 'post')

        const populatedPost = await Post.findOne({ _id: updatedPost._id }).populate([
            {
                path: 'author',
                model: Profile,
                populate: {
                    path: 'user'
                }
            },
            {
                path: 'parentPost',
                model: Post,
                populate: [{
                    path: 'author',
                    model: Profile
                }, {
                    path: 'author.user'
                }]
            },
            {
                path: 'comments',
                model: Comment,
                populate: [commentAuthorPopulate, commentReplyPopulate]
            }
        ])

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
        
        const currentUserId = profile._id
        const connectsList = profile.connects || []
        const blockedUsers = profile.blockedUsers || []

        // Build audience filter query
        // Audience values: 1 = Public, 2 = Connects, 3 = Only Me
        const audienceFilter = {
            $and: [
                {
                    $or: [
                        // Public posts (audience = 1) - everyone can see
                        { audience: 1 },
                        // Connects posts (audience = 2) - only connects can see
                        // Check if author is in current user's connects list (bidirectional connection)
                        {
                            audience: 2,
                            author: { $in: connectsList }
                        },
                        // Only Me posts (audience = 3) - only author can see
                        {
                            audience: 3,
                            author: currentUserId
                        }
                    ]
                },
                // Exclude posts from blocked users
                {
                    author: { $nin: blockedUsers }
                }
            ]
        }

        const RANK_WINDOW = 40
        const connectIds = new Set((connectsList || []).map((id) => String(id)))
        const authorLite = {
            path: 'author',
            select: 'fullName displayName username nickname profilePic isOfficial isVerified isActive lastActive user',
            populate: {
                path: 'user',
                select: 'firstName surname',
            },
        }

        const rankedWindow = await Post.find(audienceFilter).populate([
            authorLite,
            {
                path: 'parentPost',
                model: Post,
                select: 'author caption photos type createdAt',
                populate: authorLite,
            },
        ]).sort({ createdAt: -1 }).limit(RANK_WINDOW).lean()

        const ranked = rankPosts(rankedWindow, {
            connectIds,
            currentUserId: String(currentUserId),
        })
        const start = (pageNumber - 1) * limit
        const newsFeedPosts = ranked.slice(start, start + limit)
        await Post.populate(newsFeedPosts, commentPopulate)
        const hasNewPost = start + limit < ranked.length
        res.status(200).json({ posts: newsFeedPosts, hasNewPost })

    } catch (error) {
        console.log(error)
        next(error)
    }
}
