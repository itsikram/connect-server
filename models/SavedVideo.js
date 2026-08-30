const { Schema, model } = require('mongoose');

const Flexible = Schema.Types.Mixed;

const savedVideoSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    videoId: {
      type: String,
      required: true,
    },
    metadata: {
      _id: String,
      caption: String,
      author: {
        name: String,
        fullName: String,
        profilePic: String,
        pk: String,
      },
      thumbnail: String,
      aspectRatio: String,
      videoURL: String,
      likes: Flexible,
      comments: Flexible,
      shares: Flexible,
      timestamp: Number,
      takenAt: Number,
      duration: Number,
      playCount: Flexible,
    },
    // Canonical source URL used to restore/download again after cache clear
    sourceUrl: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'deleted'],
      default: 'active',
    },
    downloadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Compound unique index for userId and videoId
savedVideoSchema.index({ userId: 1, videoId: 1 }, { unique: true });

module.exports = model('SavedVideo', savedVideoSchema);
