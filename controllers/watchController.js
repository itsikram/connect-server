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
        let profileId = req.profile._id
        let watchId = req.body.watchId
        let authorId = req.body.authorId;

        if (profileId == authorId) {
            let deleteWatch = await Watch.findOneAndDelete({ _id: watchId })

            if (deleteWatch) {
                res.json({
                    message: 'Watch Deleted Successfully'
                }).status(200)
            }


        }




    } catch (error) {
        next(error)
    }
}

exports.getRelatedWatchs = async (req, res, next) => {

    try {
        let profile_id = req.query.profile;

        // if(!mongoose.isValidObjectId(profile_id)) return res.json().status(400)
        let watches = await Watch.find().populate([
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

        res.json(watches).status(200)

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
    let profile = req.profile
    let pageNumber = req.query.pageNumber
    let limit = 3
    try {

        let newsFeedWatchs = await Watch.find().populate([
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

        let nextWatchs = await Watch.find().skip((pageNumber) * limit).limit(limit).sort({ 'createdAt': -1 })

        let hasNewWatch = nextWatchs.length == 0 ? false : true
        res.json({ watchs: newsFeedWatchs, hasNewWatch }).status(200)

    } catch (error) {
        console.log(error)
        next(error)
    }
}



