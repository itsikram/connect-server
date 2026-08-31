//import {Schema,model} from 'mongoose'
const {Schema,model} = require('mongoose')
const Profile = require('./Profile')
const Comment = require('./Comment')


let postSchema = new Schema({
    caption: {
        type: String,
        maxLength: 500,
    },
    photos: {
        type: String,
        maxLength: 250,
    },
    reacts: [{
        profile: {
            type: Schema.Types.ObjectId,
            ref: Profile
        },
        type: {
            type: String
        }
    }],
    comments: [{
        type: Schema.Types.ObjectId,
        ref: Comment
    }],
    shares: [{
        type: Schema.Types.ObjectId,
        ref: Profile
    }],
    viewers: [{
        type: Schema.Types.ObjectId,
        ref: Profile
    }],
    audience: {
        type: Number,
        default: 3
    },
    author: {
        type: Schema.Types.ObjectId,
        ref: Profile
    },
    parentPost: {
        type: Schema.Types.ObjectId,
        ref: Profile
    },
    faceExpression: String,
    location: String,
    feelings: String,
    type: {
        type: String,
        default: 'post'
    },
    source: {
        type: String,
        default: 'user'
    }

},{
    timestamps: true
})


let Post = model('Post',postSchema)


module.exports = Post;