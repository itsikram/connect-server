//import {Schema,model} from 'mongoose'
const {Schema,model} = require('mongoose')
const Profile = require('./Profile')
const Comment = require('./Comment')


let watchSchema = new Schema({
    caption: {
        type: String,
        maxLength: 500,
    },
    thumbnail: String,
    videoUrl: String,
    reacts: [{
        type: Object,
        ref: Profile

    }],
    comments: [{
        type: Schema.Types.ObjectId,
        ref: Comment
    }],
    feeling: {
        type: String
    },
    shares: [{
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
    type: {
        type: String,
        default: 'watch'
    }

},{
    timestamps: true
})


let Watch = model('Watch',watchSchema)


module.exports = Watch;