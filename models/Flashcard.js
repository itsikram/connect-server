const { Schema, model } = require('mongoose');
const Profile = require('./Profile');

const flashcardSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: Profile,
        required: true,
        index: true
    },
    deckName: {
        type: String,
        required: true,
        trim: true,
        maxLength: 100
    },
    cards: [{
        front: {
            type: String,
            required: true,
            maxLength: 500
        },
        back: {
            type: String,
            required: true,
            maxLength: 500
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
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
flashcardSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const Flashcard = model('Flashcard', flashcardSchema);

module.exports = Flashcard;
