const { Schema, model } = require('mongoose');
const Profile = require('./Profile');

const habitSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: Profile,
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true,
        maxLength: 100
    },
    color: {
        type: String,
        default: '#22C55E'
    },
    streak: {
        type: Number,
        default: 0
    },
    longestStreak: {
        type: Number,
        default: 0
    },
    records: {
        type: Map,
        of: Boolean,
        default: {}
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Update updatedAt before saving
habitSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const Habit = model('Habit', habitSchema);

module.exports = Habit;
