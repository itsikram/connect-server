const {Schema,model} = require('mongoose')

let userSchema = new Schema({
    firstName: {
        type: String,
        trim: true,
        required: true
    },
    surname: {
        type: String,
        trim: true,
        required: true
    },
    nickname: {
        type: String,
    },
    username: String,
    email: {
        type: String,
        trim: true,
        required: true,
        minLength: 10,
        maxLength: 40,
    },
    password: {
        type: String,
        trim: true,
        required: false, // Make password optional for Google users
    },
    faceLoginEnabled: {
        type: Boolean,
        default: false,
    },
    googleId: {
        type: String,
        trim: true,
        unique: true,
        sparse: true, // Allow multiple null values
    },
    DOB: {
        type: String,
        required: false // Make optional for Google users
    },
    gender: {
        type: String,
        trim: true,
        required: false // Make optional for Google users
    },
    lastLogin :{
        type : Number,
        default: new Date(Date.now()).getTime(),
        
    },
    profile: {
        'ref' : 'Profile',
        type: Schema.Types.ObjectId
    },
    resetPasswordToken: {
        type: String
    },
    resetPasswordExpire: {
        type: Date
    }
},{timestamps: true})

let User = model('User',userSchema)

module.exports = User