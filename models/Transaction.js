const {Schema,model} = require('mongoose')

const transactionSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    type: {
        type: String,
        enum: [
            'subscription',
            'wallet_topup',
            'tip_sent',
            'tip_received',
            'coaching_purchase',
            'affiliate_commission'
        ],
        required: true
    },
    subscriptionTier: {
        type: String,
        enum: ['plus_basic', 'plus_pro'],
        default: null
    },
    coachingPlanId: {
        type: String,
        trim: true,
        default: null
    },
    amountBDT: {
        type: Number,
        required: true,
        min: 0
    },
    coinsAmount: {
        type: Number,
        default: null,
        min: 0
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    paymentMethod: {
        type: String,
        enum: ['bkash', 'nagad'],
        required: true
    },
    senderMsisdn: {
        type: String,
        trim: true,
        required: true
    },
    transactionId: {
        type: String,
        trim: true,
        required: true
    },
    screenshotUrl: {
        type: String,
        default: null
    },
    submittedAt: {
        type: Date,
        default: Date.now
    },
    reviewedAt: {
        type: Date,
        default: null
    },
    reviewedByAdminId: {
        type: String,
        default: null
    },
    rejectionReason: {
        type: String,
        default: null
    },
    auditLog: [{
        action: {
            type: String,
            enum: ['approved', 'rejected'],
            required: true
        },
        adminId: {
            type: String,
            required: true
        },
        timestamp: {
            type: Date,
            required: true
        }
    }]
},{timestamps: true})

transactionSchema.index({ transactionId: 1, paymentMethod: 1 }, { unique: true })

const Transaction = model('Transaction', transactionSchema)

module.exports = Transaction
