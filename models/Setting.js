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
    language: {
        type: String,
        enum: ['eng', 'bn'],
        default: 'eng',
    },
    postVisibility: {
        type: String,
        default: 'public',
    },
    connectRequestVisibility: {
        type: String,
        default: 'public',
    },
    timelinePostVisibility: {
        type: String,
        default: 'public',
    },
    connectRequestReceived: {
        type: Boolean,
        default: true,
    },
    connectRequestAccepted: {
        type: Boolean,
        default: true,
    },
    newMessageReceived: {
        type: Boolean,
        default: true,
    },
    newConnectPost: {
        type: Boolean,
        default: true,
    },
    newConnectStory: {
        type: Boolean,
        default: true,
    },
    newConnectWatch: {
        type: Boolean,
        default: true,
    },
    connectRequestReceivedEmail: {
        type: Boolean,
        default: false,
    },
    connectRequestAcceptedEmail: {
        type: Boolean,
        default: false,
    },
    newMessageReceivedEmail: {
        type: Boolean,
        default: false,
    },
    newConnectPostEmail: {
        type: Boolean,
        default: false,
    },
    newConnectStoryEmail: {
        type: Boolean,
        default: false,
    },
    newConnectWatchEmail: {
        type: Boolean,
        default: false,
    },
    chatBackground: {
        type: String,
        default: null,
    },
    connectChatSettings: {
        type: Schema.Types.Mixed,
        default: {},
    },
    profile: {
        ref: Profile,
        type: Schema.Types.ObjectId,
    },
}, { timestamps: true })

let Setting = model('Setting', settingSchema)

module.exports = Setting
