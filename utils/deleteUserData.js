const Story = require('../models/Story')
const Post = require('../models/Post')
const Watch = require('../models/Watch')
const Message = require('../models/Message')
const Comment = require('../models/Comment')
const CmntReply = require('../models/CmntReply')
const Setting = require('../models/Setting')
const FaceEndCoding = require('../models/FaceEncoding')
const Profile = require('../models/Profile')
const { deleteCloudinaryResources } = require('./cloudinaryCleanup')

const deleteUserData = async (profileId) => {
    const [profile, stories, posts, watches, messages, comments, replies, settings] = await Promise.all([
        Profile.findById(profileId).select('profilePic coverPic'),
        Story.find({ author: profileId }).select('image music'),
        Post.find({ author: profileId }).select('photos'),
        Watch.find({ author: profileId }).select('videoUrl thumbnail'),
        Message.find({ $or: [{ senderId: String(profileId) }, { receiverId: String(profileId) }] }).select('attachment'),
        Comment.find({ author: profileId }).select('attachment'),
        CmntReply.find({ author: profileId }).select('attachment'),
        Setting.findOne({ profile: profileId }).select('chatBackground'),
    ])

    await Promise.all([
        Story.deleteMany({ author: profileId }),
        Post.deleteMany({ author: profileId }),
        Watch.deleteMany({ author: profileId }),
        Message.deleteMany({ $or: [{ senderId: String(profileId) }, { receiverId: String(profileId) }] }),
        Comment.deleteMany({ author: profileId }),
        CmntReply.deleteMany({ author: profileId }),
        Setting.deleteMany({ profile: profileId }),
        FaceEndCoding.deleteMany({ profile: profileId }),
    ])

    await deleteCloudinaryResources([
        profile?.profilePic,
        profile?.coverPic,
        ...stories.flatMap((story) => [story.image, story.music]),
        ...posts.map((post) => post.photos),
        ...watches.flatMap((watch) => [watch.videoUrl, watch.thumbnail]),
        ...messages.map((message) => message.attachment),
        ...comments.map((comment) => comment.attachment),
        ...replies.map((reply) => reply.attachment),
        settings?.chatBackground,
    ])
}

module.exports = deleteUserData