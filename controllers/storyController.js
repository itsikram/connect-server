const Story = require('../models/Story')
const Profile = require('../models/Profile')
const Comment = require('../models/Comment')
const CmntReply = require('../models/CmntReply')
const mongoose = require('mongoose')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')

exports.postStory = async(req,res,next) => {
    try {
        let profileId = req.profile._id
        let image = req.body.image || ''
        let storyBg = req.body.storyBg || ''
        let audience = parseInt(req.body.audience, 10) || 1
        let story = new Story({
            image,
            bgColor: storyBg,
            audience,
            author: profileId
        })

        let savedData = await story.save()
        if(savedData) {
            return res.json({
                message: 'Story Created Successfully'
            }).status(200)
        }
        
    } catch (error) {
        next(error)
    }

}

exports.deleteStory = async (req,res,next) => {
    try {
        let profileId = req.profile._id
        let storyId = req.body.storyId
        let story = await Story.findOne({_id: storyId})

        if(profileId == (story.author._id).toString()) {
            const comments = await Comment.find({ post: storyId }).select('attachment replies')
            const replies = await CmntReply.find({ parent: { $in: comments.map((comment) => comment._id) } }).select('attachment')
            let deleteStory = await Story.findOneAndDelete({_id: storyId})
            if(deleteStory) {
                await Promise.all([
                    Comment.deleteMany({ post: storyId }),
                    CmntReply.deleteMany({ parent: { $in: comments.map((comment) => comment._id) } }),
                ])
                await deleteCloudinaryResources([
                    deleteStory.image,
                    deleteStory.music,
                    ...comments.map((comment) => comment.attachment),
                    ...replies.map((reply) => reply.attachment),
                ])
                return res.json({
                    message: 'Story Deleted Successfully'
                }).status(200)
            }else {
                return res.json({
                    message: 'Story Cannot Be Deleted'
                }).status(400)
            }
        }

    } catch (error) {
        next(error)
    }
}

exports.getMyStories = async(req,res,next) => {

    try {
        let profile_id = req.query.profile;

        if(mongoose.isValidObjectId(profile_id)) {
            let stories = await Story.find({author: profile_id}).populate([
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
                    populate: {
                        path: 'author',
                        select: ['profilePic','user'],
                        populate: {
                            path: 'user',
                            select: ['firstName','surname']
                        }
                    }
                }
            ]).sort({'createdAt': -1})
    
            return res.json(stories).status(200)
        }

        return res.json({message: 'Invalid Profile Id'}).status(403)

        
    } catch (error) {
        next(error)
    }
}

exports.getSingleStory = async(req,res,next) => {
    try {

        let storyId = req.query.storyId;


        if(mongoose.isValidObjectId(storyId)) {
            let story = await Story.findById(storyId).populate([
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
            ])
    
            return res.status(200).json(story)
        }

        return res.json({message: 'Invalid story id passed'}).status(404)



        
    } catch (error) {
        console.log(error)
    }
}


exports.getAllStories = async(req,res,next) => {

    try {
        const profile = req.profile;
        const visibilityFilter = profile
            ? {
                $or: [
                    { audience: 1 },
                    { audience: 2, author: { $in: profile.connects || [] } },
                    { audience: 3, author: profile._id },
                ],
            }
            : { audience: 1 };
        const blockedAuthorsFilter = {
            author: { $nin: profile?.blockedUsers || [] },
        };

        let newsFeedStories = await Story.find({
            $and: [visibilityFilter, blockedAuthorsFilter],
        }).populate([
            {
                path: 'author',
                model: Profile,
                select: ['profilePic', 'fullName', 'user'],
                populate: {
                    path: 'user',
                    select: ['firstName', 'surname']
                }
            },
            {
                path: 'comments',
                model: Comment,
                populate: {
                    path: 'author',
                    select: ['profilePic','user'],
                    populate: {
                        path: 'user',
                        select: ['firstName','surname']
                    }
                }
            }
        ]).limit(10).sort({'createdAt': -1})

        res.json(newsFeedStories).status(200)
        
    } catch (error) {
        console.log(error)
        next(error)
    }
}
