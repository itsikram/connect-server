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
    youtubeId: {
        type: String,
        index: true,
        sparse: true,
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
    },
    aiMetadata: {
        status: { type: String, enum: ['pending', 'ready', 'failed'], default: 'pending', index: true },
        categories: { type: [String], default: [] },
        embedding: { type: [Number], default: undefined },
        embeddingModel: String,
        provider: String,
        contentHash: { type: String, index: true },
        sentiment: String,
        contentSafetyFlags: { type: [String], default: [] },
        processedAt: Date,
        error: String
    }

},{
    timestamps: true
})


let Watch = model('Watch',watchSchema)


module.exports = Watch;