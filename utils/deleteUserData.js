const Story = require('../models/Story')
const Post = require('../models/Post')
const Watch = require('../models/Watch')
const Message = require('../models/Message')
const Comment = require('../models/Comment')
const CmntReply = require('../models/CmntReply')
const Setting = require('../models/Setting')
const FaceEndCoding = require('../models/FaceEncoding')

const deleteUserData = async (profileId) => {
    await Story.deleteMany({ author: profileId })
    await Post.deleteMany({
        author: profileId
    })
    await Watch.deleteMany({ author: profileId })
    await Message.deleteMany({
        senderId: profileId,
        receiverId: profileId
    })
    await Comment.deleteMany({ author: profileId })
    await CmntReply.deleteMany({ author: profileId })
    await Setting.deleteMany({ profile: profileId })
    await FaceEndCoding.deleteMany({ profile: profileId })
}

module.exports = deleteUserData