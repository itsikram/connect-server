const {Schema,model} = require('mongoose')
const Profile = require('./Profile')

  
const messageSchema = new Schema({
    room: String,
    senderId: String,
    receiverId: String,
    message: String,
    // Optional message metadata
    messageType: { type: String, enum: ['text', 'call'], default: 'text' },
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
    timestamp: { type: Date, default: Date.now }
});
const Message = model("Message", messageSchema);

module.exports = Message
