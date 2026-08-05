const {Schema,model} = require('mongoose')

let adminSchema = new Schema({
    fullName: {
        type: String,
        trim: true,
        required: true
    },
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
        required: true,
    },

    role: {
        type: String,
        required: true,
        enum: ['superAdmin', 'admin', 'moderator'],
        trim: true,
        default: 'superAdmin'
    },
    resetPasswordToken: {
        type: String,
        trim: true,
    },
    resetPasswordExpire: {
        type: Date,
    },

},{timestamps: true})

let Admin = model('Admin',adminSchema)

module.exports = Admin