const {Schema,model} = require('mongoose')
const Profile = require('./Profile')
const config = require('../config/config.json');
const NotificationSchema = new Schema({
    receiverId: {
        type: Schema.Types.ObjectId,
        ref: Profile
    },
    text: String,
    title: {
        type: String,
    },
    icon: {
        type: String,
        default: config?.logo
    },
    link: String,
    type: String,
    data: {
        type: Schema.Types.Mixed,
        default: {}
    },
    reacts: [{
        type: Object,
        ref: Profile

    }],
    isSeen: {
        type: Boolean,
        default: false
    },
    timestamp: { type: Date, default: Date.now }
});

NotificationSchema.index({ receiverId: 1, isSeen: 1, timestamp: -1 });
NotificationSchema.index({ receiverId: 1, timestamp: -1 });

const Notification = model('Notification', NotificationSchema);

module.exports = Notification