const {Schema,model} = require('mongoose')
const Profile = require('./Profile')

  
const messageSchema = new Schema({
    room: String,
    senderId: String,
    receiverId: String,
    message: String,
    parent: {
        type: Schema.Types.ObjectId,
        ref: 'Message',
    },
    attachment: String,
    reacts: [{
        type: Schema.Types.ObjectId,
        ref: Profile

    }],
    isSeen: {
        type: Boolean,
        default: false
    },
    timestamp: { type: Date, default: Date.now }
});
const Message = model("Message", messageSchema);

module.exports = Message
