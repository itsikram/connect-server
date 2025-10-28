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

const Notification = model('Notification', NotificationSchema);

module.exports = Notification