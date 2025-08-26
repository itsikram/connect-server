const {Schema,model } = require('mongoose')
const User = require('./User')


let profileSchema = new Schema({
    username: {
        type: String,
        minLength: 5,
        maxLength: 50,
        trim: true
    },
    nickname: {
        type: String,
        minLength: 2,
        maxLength: 50
    },
    fullName: {
        type: String,
    },
    displayName: {
        type: String,
    },
    coverPic: {
        type: String,
        default: 'https://programmerikram.com/wp-content/uploads/2025/03/default-cover.png'
    },
    profilePic: {
        type: String,
        default: 'https://programmerikram.com/wp-content/uploads/2025/03/default-profilePic.png'
    },
    bio: {
        type: String,
        maxLength: 200,
        default: 'Hello World, I am a new User'
    },
    friends: [{
        type: Schema.Types.ObjectId,
        ref: 'Profile'
    }],
    lastEmotion: String,
    friendReqs: [{
        type: Schema.Types.ObjectId,
        ref: 'Profile'
    }],
    workPlaces: [{
        type: Object
    }],
    schools: [{
        type: Object
    }],
    presentAddress: String,
    permanentAddress: String,
    following: [{
        type: Schema.Types.ObjectId
    }],
    blockedUsers: [{
        type: Schema.Types.ObjectId
    }],
    settings: {
        type: Object,
    },
    isActive: {
        type: Boolean,
        default: false
    },
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User'
    }

},{timestamps: true})

let Profile = model('Profile',profileSchema)


module.exports  = Profile



