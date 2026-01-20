const { Schema, model } = require('mongoose');
const Profile = require('./Profile');

const timerSessionSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: Profile,
        required: true,
        index: true
    },
    completedSessions: {
        type: Number,
        default: 0
    },
    lastSessionType: {
        type: String,
        enum: ['focus', 'short', 'long'],
        default: 'focus'
    },
    lastSessionDate: {
        type: Date
    }
}, {
    timestamps: true
});

const TimerSession = model('TimerSession', timerSessionSchema);

module.exports = TimerSession;
