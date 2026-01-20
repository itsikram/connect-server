const { Schema, model } = require('mongoose');
const Profile = require('./Profile');

const noteSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: Profile,
        required: true,
        index: true
    },
    title: {
        type: String,
        required: true,
        trim: true,
        maxLength: 200
    },
    content: {
        type: String,
        default: '',
        maxLength: 10000
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Update updatedAt before saving
noteSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const Note = model('Note', noteSchema);

module.exports = Note;
