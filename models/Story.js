const { Schema, model } = require('mongoose')
const Profile = require('./Profile')
const Comment = require('./Comment')

let storySchema = new Schema({

    image: {
        type: String,
        maxLength: 250,
    },
    music: {
        type: String,
        maxLength: 250,
    },
    reacts: [{
        type: Object,
        ref: Profile
    }],
    bgColor: String,
    seenBy:[{
        type: Schema.Types.ObjectId,
        ref: Profile
    }],
    comments: [{
        type: Schema.Types.ObjectId,
        ref: Comment
    }],
    audience: {
        type: Number,
        default: 3
    },
    author: {
        type: Schema.Types.ObjectId,
        ref: Profile
    }

}, {
    timestamps: true
})


let Story = model('Story', storySchema)


module.exports = Story;