const {Schema,model} = require('mongoose')
const Profile = require('./Profile')

  
const messageSchema = new Schema({
    room: String,
    senderId: String,
    receiverId: String,
    message: String,
    // Optional message metadata
    messageType: { type: String, enum: ['text', 'call', 'audio'], default: 'text' },
    callType: { type: String, enum: ['audio', 'video'], required: false },
    callEvent: { type: String, enum: ['missed', 'ended', 'declined', 'started'], required: false },
    parent: {
        type: Schema.Types.ObjectId,
        ref: 'Message',
    },
    attachment: String,
    reacts: [{
        type: Schema.Types.ObjectId,
        ref: Profile

    }],
    tempId: String,
    isSeen: {
        type: Boolean,
        default: false
    },
    unseenReminderEmailSentAt: {
        type: Date,
        default: null
    },
    unseenReminderEmailProcessingKey: {
        type: String,
        default: null
    },
    unseenReminderEmailProcessingAt: {
        type: Date,
        default: null
    },
    unseenReminderEmailLastError: {
        type: String,
        default: null
    },
    timestamp: { type: Date, default: Date.now }
});

messageSchema.index({ senderId: 1, receiverId: 1, timestamp: -1 });
messageSchema.index({ receiverId: 1, timestamp: -1 });
messageSchema.index({ senderId: 1, timestamp: -1 });
messageSchema.index({
    isSeen: 1,
    messageType: 1,
    unseenReminderEmailSentAt: 1,
    unseenReminderEmailProcessingAt: 1,
    receiverId: 1,
    senderId: 1,
    timestamp: 1
});

const Message = model("Message", messageSchema);

module.exports = Message
