const Watch = require('../models/Watch')
const Profile = require('../models/Profile')
const User = require('../models/User')
const Comment = require('../models/Comment')
const jwt = require('jsonwebtoken')
const CmntReply = require('../models/CmntReply')
const mongoose = require('mongoose')
const Post = require('../models/Post')
const generateAndUploadThumbnail = require('../utils/generateThumbnail')

exports.createWatch = async (req, res, next) => {
    const profileId = req.profile._id
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

        const watch = new Watch({
            caption,
            videoUrl,
            author: profileId,
            thumbnail,
            feeling,
            audience,
        })

        const savedData = await watch.save()
        const populated = await Watch.findById(savedData._id).populate([
            {
                path: 'author',
                select: ['profilePic', 'user', 'fullName', 'displayName'],
                populate: {
                    path: 'user',
                    select: ['firstName', 'surname'],
                },
            },
        ])

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
        const profileId = req.profile?._id
        const watchId = req.body.watchId

        if (!profileId) {
            return res.status(401).json({ message: 'Authentication required' })
        }

        if (!watchId || !mongoose.isValidObjectId(watchId)) {
            return res.status(400).json({ message: 'Valid watchId is required' })
        }

        // Only the author can delete — verify ownership server-side
        const deleted = await Watch.findOneAndDelete({
            _id: watchId,
            author: profileId,
        })

        if (!deleted) {
            // Distinguish not found vs not authorized
            const existing = await Watch.findById(watchId).select('author')
            if (!existing) {
                return res.status(404).json({ message: 'Watch not found' })
            }
            return res.status(403).json({ message: 'Not authorized to delete this watch' })
        }

        return res.status(200).json({
            message: 'Watch Deleted Successfully',
            watchId,
        })
    } catch (error) {
        console.error('deleteWatch error:', error)
        return next(error)
    }
}

exports.getRelatedWatchs = async (req, res, next) => {

    try {
        const pageSize = Math.min(parseInt(req.query.limit, 10) || 24, 40);
        const watches = await Watch.find()
            .select('caption thumbnail videoUrl reacts comments shares feeling audience author type createdAt')
            .populate({
                path: 'author',
                select: 'profilePic user fullName displayName',
                populate: {
                    path: 'user',
                    select: 'firstName surname',
                },
            })
            .populate({
                path: 'comments',
                select: 'body attachment author timestamp reacts',
                populate: {
                    path: 'author',
                    select: 'profilePic user',
                    populate: {
                        path: 'user',
                        select: 'firstName surname',
                    },
                },
            })
            .sort({ createdAt: -1 })
            .limit(pageSize)
            .lean();

        return res.status(200).json(watches);

    } catch (error) {
        next(error)
    }
}

exports.getMyWatchs = async (req, res, next) => {

    try {
        let profile_id = req.query.profile;
        if (profile_id == req.profile._id  && !req.query.profile) {
            profile_id = req.profile._id
        }
        if (!mongoose.isValidObjectId(profile_id)) return res.json().status(400)
        let watchs = await Watch.find({ author: profile_id }).populate([
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

        res.json(watchs).status(200)

    } catch (error) {
        next(error)
    }
}

exports.getSingleWatch = async (req, res, next) => {

    try {

        let { watchId } = req.query

        let watch = await Watch.findOne({ _id: watchId }).populate([
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
            }

        ])

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
        let authorId = req.profile?._id

        let updateFields = {}
        if (caption !== undefined) updateFields.caption = caption
        if (audience !== undefined) updateFields.audience = Number(audience)

        if (!watchId || Object.keys(updateFields).length === 0) {
            return res.status(400).json({ message: 'Nothing to update' })
        }

        let query = { _id: watchId }
        if (authorId) query.author = authorId

        let updatedWatch = await Watch.findOneAndUpdate(query, updateFields, { new: true })

        if (updatedWatch) {
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
        const filter = {}
        if (profileId) {
            if (!mongoose.isValidObjectId(profileId)) {
                return res.status(400).json({ message: 'Valid profile is required' })
            }
            filter.author = profileId
        }

        const newsFeedWatchs = await Watch.find(filter).populate([
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
            }

        ]).skip((pageNumber - 1) * limit).limit(limit).sort({ 'createdAt': -1 })

        const nextWatchs = await Watch.find(filter).skip(pageNumber * limit).limit(limit).sort({ 'createdAt': -1 })

        let hasNewWatch = nextWatchs.length == 0 ? false : true
        res.json({ watchs: newsFeedWatchs, hasNewWatch }).status(200)

    } catch (error) {
        console.log(error)
        next(error)
    }
}

exports.shareWatch = async (req, res, next) => {
    try {
        const profileId = req.profile._id
        const watchId = req.body.watchId
        const caption = req.body.caption || ''

        if (!mongoose.isValidObjectId(watchId)) {
            return res.status(400).json({ message: 'Watch share failed' })
        }

        const theWatch = await Watch.findById(watchId)
        if (!theWatch) {
            return res.status(404).json({ message: 'Watch not found' })
        }

        const sharedPost = new Post({
            caption,
            photos: theWatch.thumbnail || '',
            author: profileId,
            type: 'shareWatch',
            location: String(watchId),
        })
        const savedPost = await sharedPost.save()

        const updateWatch = await Watch.findOneAndUpdate(
            { _id: watchId },
            { $push: { shares: profileId } },
            { new: true }
        )

        const getPost = await Post.findById(savedPost._id).populate([
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
            }
        ])

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

