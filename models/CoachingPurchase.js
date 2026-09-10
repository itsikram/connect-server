const {Schema,model} = require('mongoose')

const coachingPurchaseSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    transactionId: {
        type: Schema.Types.ObjectId,
        ref: 'Transaction',
        required: true,
        unique: true
    },
    planId: {
        type: String,
        required: true,
        trim: true
    },
    unlockedAt: {
        type: Date,
        default: Date.now
    }
},{timestamps: true})

const CoachingPurchase = model('CoachingPurchase', coachingPurchaseSchema)

module.exports = CoachingPurchase
