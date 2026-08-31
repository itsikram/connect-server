const Post = require('../models/Post')
const Profile = require('../models/Profile')
const User = require('../models/User')
const Comment = require('../models/Comment')
const jwt = require('jsonwebtoken')
const CmntReply = require('../models/CmntReply')
const mongoose = require('mongoose')
const { rankPosts } = require('../utils/feedRanking')

const commentPopulate = {
    path: 'comments',
    model: Comment,
    populate: [{
        path: 'author',
        select: ['profilePic', 'user', 'fullName', 'displayName'],
        populate: {
            path: 'user',
            select: ['firstName', 'surname']
        }
    }, {
        path: 'replies',
        model: CmntReply,
        populate: {
            path: 'author',
            model: Profile,
            select: ['profilePic', 'user', 'fullName', 'displayName'],
            populate: {
                path: 'user',
                select: ['firstName', 'surname']
            }
        }
    }]
}


exports.createPost = async (req, res, next) => {
    try {
        let profileId = req.profile._id
        let caption = req.body.caption
        let thumbnail_url = req.body.photos
        let feelings = req.body.feelings
        let location = req.body.location
        let audience = req.body.audience ? parseInt(req.body.audience) : 3
        // return console.log(req.body)
        let post = new Post({
            caption,
            photos: thumbnail_url,
            author: profileId,
            feelings,
            location,
            audience

        })

        let savedData = await post.save()

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
                populate: [{
                    path: 'author',
                    select: ['profilePic', 'user'],
                    populate: {
                        path: 'user',
                        select: ['firstName', 'surname']
                    }
                }, {
                    path: 'replies',
                    Model: CmntReply,
                    populate: {
                        path: 'author',
                        model: Profile
                    }
                }]
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
            let deletePost = await Post.findOneAndDelete({ _id: postId })

            if (deletePost) {
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

        let sharedPost = new Post({
            caption,
            photos: thePost.photos,
            author: profileId,
            parentPost: thePost._id,
            type: 'share'
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
                    populate: [{
                        path: 'author',
                        select: ['profilePic', 'user'],
                        populate: {
                            path: 'user',
                            select: ['firstName', 'surname']
                        }
                    }, {
                        path: 'replies',
                        Model: CmntReply,
                        populate: {
                            path: 'author',
                            model: Profile
                        }
                    }]
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
                populate: [{
                    path: 'author',
                    select: ['profilePic', 'user'],
                    populate: {
                        path: 'user',
                        select: ['firstName', 'surname']
                    }
                }, {
                    path: 'replies',
                    Model: CmntReply,
                    populate: {
                        path: 'author',
                        model: Profile
                    }
                }]
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
                populate: [{
                    path: 'author',
                    select: ['profilePic', 'user'],
                    populate: {
                        path: 'user',
                        select: ['firstName', 'surname']
                    }
                },
                {
                    path: 'replies',
                    Model: CmntReply,
                    populate: {
                        path: 'author',
                        model: Profile
                    }
                }]
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
    let { postId, caption, feelings, location, photos, audience } = req.body
    try {
        let updateData = {}

        if (caption !== undefined) {
            updateData.caption = caption
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
        
        if (audience !== undefined) {
            updateData.audience = audience
        }

        let updatedPost = await Post.findOneAndUpdate({ _id: postId }, updateData, { new: true })

        if (!updatedPost) {
            return res.status(404).json({ message: 'Post not found' })
        }

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
                populate: [{
                    path: 'author',
                    select: ['profilePic', 'user'],
                    populate: {
                        path: 'user',
                        select: ['firstName', 'surname']
                    }
                }, {
                    path: 'replies',
                    Model: CmntReply,
                    populate: {
                        path: 'author',
                        model: Profile
                    }
                }]
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
        const friendsList = profile.friends || []
        const blockedUsers = profile.blockedUsers || []

        // Build audience filter query
        // Audience values: 1 = Public, 2 = Friends, 3 = Only Me
        const audienceFilter = {
            $and: [
                {
                    $or: [
                        // Public posts (audience = 1) - everyone can see
                        { audience: 1 },
                        // Friends posts (audience = 2) - only friends can see
                        // Check if author is in current user's friends list (bidirectional friendship)
                        {
                            audience: 2,
                            author: { $in: friendsList }
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
        const friendIds = new Set((friendsList || []).map((id) => String(id)))
        const authorLite = {
            path: 'author',
            select: 'fullName displayName username nickname profilePic isOfficial isActive lastActive user',
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
            friendIds,
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



