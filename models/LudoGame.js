const {Schema, model} = require('mongoose')
const Profile = require('./Profile')

const ludoGameSchema = new Schema({
    gameId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    host: {
        type: Schema.Types.ObjectId,
        ref: Profile,
        required: true
    },
    players: [{
        id: {
            type: Number,
            required: true
        },
        name: {
            type: String,
            required: true
        },
        color: {
            type: String,
            required: true
        },
        avatar: String,
        cover: String,
        profileId: {
            type: Schema.Types.ObjectId,
            ref: Profile
        },
        isActive: {
            type: Boolean,
            default: true
        },
        isOffline: {
            type: Boolean,
            default: false
        },
        pieces: [{
            id: {
                type: Number,
                required: true
            },
            color: String,
            steps: {
                type: Number,
                default: 0
            },
            isHome: {
                type: Boolean,
                default: true
            },
            isInPlay: {
                type: Boolean,
                default: false
            }
        }]
    }],
    currentPlayer: {
        type: Number,
        default: 0
    },
    diceValue: {
        type: Number,
        default: 0
    },
    gameStarted: {
        type: Boolean,
        default: false
    },
    gameEnded: {
        type: Boolean,
        default: false
    },
    winners: [{
        id: Number,
        name: String,
        color: String,
        avatar: String,
        profileId: {
            type: Schema.Types.ObjectId,
            ref: Profile
        }
    }],
    selectedPlayerCount: {
        type: Number,
        default: 4,
        min: 2,
        max: 4
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
})

// Index for faster queries
ludoGameSchema.index({ gameId: 1 })
ludoGameSchema.index({ host: 1 })
ludoGameSchema.index({ 'players.profileId': 1 })
ludoGameSchema.index({ lastUpdated: -1 })

// Auto-update lastUpdated on save
ludoGameSchema.pre('save', function(next) {
    this.lastUpdated = new Date()
    next()
})

// Auto-update lastUpdated on update
ludoGameSchema.pre(['updateOne', 'findOneAndUpdate'], function(next) {
    this.set({ lastUpdated: new Date() })
    next()
})

const LudoGame = model('LudoGame', ludoGameSchema)

module.exports = LudoGame

