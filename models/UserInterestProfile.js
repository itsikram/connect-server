const { Schema, model } = require('mongoose');

const userInterestProfileSchema = new Schema({
    profile: { type: Schema.Types.ObjectId, ref: 'Profile', unique: true, required: true, index: true },
    categories: { type: Map, of: Number, default: {} },
    embedding: { type: [Number], default: undefined },
    interactionCount: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = model('UserInterestProfile', userInterestProfileSchema);
