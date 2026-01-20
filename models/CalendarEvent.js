const { Schema, model } = require('mongoose');
const Profile = require('./Profile');

const calendarEventSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: Profile,
        required: true,
        index: true
    },
    title: {
        type: String,
        required: true,
        trim: true,
        maxLength: 200
    },
    date: {
        type: Date,
        required: true,
        index: true
    },
    time: {
        type: String,
        trim: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

const CalendarEvent = model('CalendarEvent', calendarEventSchema);

module.exports = CalendarEvent;
