const { Schema, model } = require('mongoose')
const Profile = require('./Profile')

let settingSchema = new Schema({
    username: {
        type: String,
        trim: true,
    },
    nickanme: {
        type: String,
        trim: true,
    },
    isShareEmotion: {
        type: Boolean,
        default: false,
    },
    isShareLocation: {
        type: Boolean,
        default: true,
    },
    showIsTyping: {
        type: Boolean,
        default: true,
    },
    ringtone: {
        type: Number,
        default: 1,
    },
    actionEmoji: String,
    themeMode: {
        type: String,
        default: 'dark',
    },
    postVisibility: {
        type: String,
        default: 'public',
    },
    friendRequestVisibility: {
        type: String,
        default: 'public',
    },
    timelinePostVisibility: {
        type: String,
        default: 'public',
    },
    friendRequestReceived: {
        type: Boolean,
        default: true,
    },
    friendRequestAccepted: {
        type: Boolean,
        default: true,
    },
    newMessageReceived: {
        type: Boolean,
        default: true,
    },
    newFriendPost: {
        type: Boolean,
        default: true,
    },
    newFriendStory: {
        type: Boolean,
        default: true,
    },
    newFriendWatch: {
        type: Boolean,
        default: true,
    },
    friendRequestReceivedEmail: {
        type: Boolean,
        default: false,
    },
    friendRequestAcceptedEmail: {
        type: Boolean,
        default: false,
    },
    newMessageReceivedEmail: {
        type: Boolean,
        default: false,
    },
    newFriendPostEmail: {
        type: Boolean,
        default: false,
    },
    newFriendStoryEmail: {
        type: Boolean,
        default: false,
    },
    newFriendWatchEmail: {
        type: Boolean,
        default: false,
    },
    profile: {
        ref: Profile,
        type: Schema.Types.ObjectId,
    },
}, { timestamps: true })

let Setting = model('Setting', settingSchema)

module.exports = Setting
