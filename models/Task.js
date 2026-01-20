const { Schema, model } = require('mongoose');
const Profile = require('./Profile');

const taskSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: Profile,
        required: true,
        index: true
    },
    text: {
        type: String,
        required: true,
        trim: true,
        maxLength: 500
    },
    completed: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

const Task = model('Task', taskSchema);

module.exports = Task;
