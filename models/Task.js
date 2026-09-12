const { Schema, model } = require('mongoose');
const Profile = require('./Profile');

const taskSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: Profile,
        required: true,
        index: true
    },
    text: {
        type: String,
        required: true,
        trim: true,
        maxLength: 500
    },
    completed: {
        type: Boolean,
        default: false
    },
    taskTime: {
        type: Date,
        index: true
    },
    notificationSent: {
        before30: { type: Boolean, default: false },
        before15: { type: Boolean, default: false },
        atTime: { type: Boolean, default: false }
    },
    reminderTime: {
        type: String,
        match: /^([01]\d|2[0-3]):[0-5]\d$/
    },
    reminderTimezone: {
        type: String,
        trim: true
    },
    lastReminderDate: {
        type: String,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

const Task = model('Task', taskSchema);

module.exports = Task;
