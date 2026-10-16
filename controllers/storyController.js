const { prisma, isValidId, toId, sameId } = require('../utils/db')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')
const {
    profileArgs,
    commentInclude,
    storyInclude,
    shapeStory,
    audienceLists,
    audienceWhere,
    deleteCommentsWhere,
    removeContent,
} = require('../services/contentShape')

// comments populated with author only (no replies), as the Mongo populate did
const authorOnlyComments = commentInclude(profileArgs(['profilePic'], ['firstName', 'surname']), undefined, false)

exports.postStory = async(req,res,next) => {
    try {
        let profileId = toId(req.profile._id)
        let image = req.body.image || ''
        let storyBg = req.body.storyBg || ''
        let audience = parseInt(req.body.audience, 10) || 1
        let savedData = await prisma.story.create({
            data: {
                image,
                bgColor: storyBg,
                audience,
                author: profileId
            }
        })
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
        let story = isValidId(storyId) ? await prisma.story.findUnique({ where: { id: String(storyId) } }) : null

        if(story && sameId(profileId, story.author)) {
            const { comments, replies, commentIds } = await deleteCommentsWhere({ story: story.id })
            await removeContent('story', story.id)
            await prisma.$transaction([
                prisma.cmntReply.deleteMany({ where: { parent: { in: commentIds } } }),
                prisma.comment.deleteMany({ where: { story: story.id } }),
            ])
            await deleteCloudinaryResources([
                story.image,
                story.music,
                ...comments.map((comment) => comment.attachment),
                ...replies.map((reply) => reply.attachment),
            ])
            return res.json({
                message: 'Story Deleted Successfully'
            }).status(200)
        }

    } catch (error) {
        next(error)
    }
}

exports.getMyStories = async(req,res,next) => {

    try {
        let profile_id = req.query.profile;

        if(isValidId(profile_id)) {
            let stories = await prisma.story.findMany({
                where: { author: String(profile_id) },
                include: storyInclude({ author: profileArgs(), comments: authorOnlyComments }),
                orderBy: { createdAt: 'desc' },
            })

            return res.json(stories.map(shapeStory)).status(200)
        }

        return res.json({message: 'Invalid Profile Id'}).status(403)


    } catch (error) {
        next(error)
    }
}

exports.getSingleStory = async(req,res,next) => {
    try {

        let storyId = req.query.storyId;


        if(isValidId(storyId)) {
            const commentAuthor = profileArgs(['profilePic', 'fullName', 'displayName'], ['firstName', 'surname'])
            let story = await prisma.story.findUnique({
                where: { id: String(storyId) },
                include: storyInclude({ author: profileArgs(), comments: commentInclude(commentAuthor) }),
            })

            return res.status(200).json(shapeStory(story))
        }

        return res.json({message: 'Invalid story id passed'}).status(404)




    } catch (error) {
        console.log(error)
    }
}


exports.getAllStories = async(req,res,next) => {

    try {
        const profile = req.profile;
        let where
        if (profile) {
            where = audienceWhere(toId(profile._id), await audienceLists(profile))
        } else {
            where = { audience: 1 }
        }

        let newsFeedStories = await prisma.story.findMany({
            where,
            include: storyInclude({
                author: profileArgs(['profilePic', 'fullName'], ['firstName', 'surname']),
                comments: authorOnlyComments,
            }),
            orderBy: { createdAt: 'desc' },
            take: 10,
        })

        res.json(newsFeedStories.map(shapeStory)).status(200)

    } catch (error) {
        console.log(error)
        next(error)
    }
}
