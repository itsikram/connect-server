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
    let profileId = req.profile._id
    let caption = req.body.caption
    let videoUrl = req.body.videoUrl
    try {


        let getThumbnail = async (videoUrl) => {
            let result = await generateAndUploadThumbnail(videoUrl)

            let thumbnail_url = result.secure_url;
            return thumbnail_url
        }

        let thumbnail = await getThumbnail(videoUrl)


        let watch = new Watch({
            caption,
            videoUrl: videoUrl,
            author: profileId,
            thumbnail

        })

        let savedData = await watch.save()
        res.json({
            message: 'Watch Created Successfully',
            data: savedData
        }).status(200)

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

        let { watchId, caption } = req.body

        let updatedWatch = await Watch.findOneAndUpdate({
            _id: watchId,
        }, {
            caption
        })

        if (updatedWatch) {
            return res.json({ message: 'Caption Updated' }).status(200)
        }

    } catch (error) {
        console.log(error)

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



