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
        trim: true,
        required: true,
        maxLength: 80
    },
    details: {
        type: String,
        trim: true,
        maxLength: 500
    },
    status: {
        type: String,
        enum: ['open', 'reviewed', 'dismissed'],
        default: 'open'
    }
}, { timestamps: true })

reportSchema.index({ type: 1, targetPost: 1, reportedBy: 1, status: 1 })
reportSchema.index({ type: 1, targetProfile: 1, reportedBy: 1, status: 1 })

const Report = model('Report', reportSchema)

module.exports = Report




