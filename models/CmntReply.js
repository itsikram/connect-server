const {Schema,model} = require('mongoose')
const Profile = require('./Profile')
const Comment = require('./Comment')
const CmntReplySchema = new Schema({
    body: {
        type: String,
        maxLength: 255
    },
    attachment: {
        type: String,
        maxLength: 255
    },
    author: {
        type:  Schema.Types.ObjectId,
        ref: Profile
    },
    post: {
        type: Schema.Types.ObjectId,
    },
    parent: {
        type:  Schema.Types.ObjectId,
        ref: 'Comment',
        required: true,
    },
    reacts: [{
        type: Object
    }]

},{timestamps: true})

const CmntReply = model('CmntReply',CmntReplySchema)

module.exports = CmntReply