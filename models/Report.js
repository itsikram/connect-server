const { Schema, model } = require('mongoose')

const reportSchema = new Schema({
    type: {
        type: String,
        enum: ['post', 'profile'],
        required: true
    },
    targetPost: {
        type: Schema.Types.ObjectId,
        ref: 'Post'
    },
    targetProfile: {
        type: Schema.Types.ObjectId,
        ref: 'Profile'
    },
    reportedBy: {
        type: Schema.Types.ObjectId,
        ref: 'Profile',
        required: true
    },
    reason: {
        type: String,
        trim: true
    },
    details: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['open', 'reviewed', 'dismissed'],
        default: 'open'
    }
}, { timestamps: true })

const Report = model('Report', reportSchema)

module.exports = Report




