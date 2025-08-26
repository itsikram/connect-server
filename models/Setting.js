const {Schema,model} = require('mongoose')
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
    isShareEmotion: Boolean,
    showIsTyping: Boolean,
    ringtone: {
        type: Number,
        default: 1
    },
    actionEmoji: String,
    themeMode: {
        type: String,
        default: 'dark'
    },

    profile: {
        ref : Profile,
        type: Schema.Types.ObjectId
    }
},{timestamps: true})

let Setting = model('Setting',settingSchema)

module.exports = Setting
