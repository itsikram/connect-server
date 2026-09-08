const { Schema, model } = require('mongoose');

const playlistItemSchema = new Schema(
  {
    queueId: { type: String, required: true },
    videoId: { type: String, required: true },
    url: { type: String, required: true },
    title: { type: String, default: 'Untitled video' },
    thumbnail: { type: String, default: '' },
    type: { type: String, default: 'url' },
    playCount: { type: Number, default: 1, min: 1, max: 99 },
  },
  { _id: false },
);

const videoPlaylistSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    items: { type: [playlistItemSchema], default: [] },
  },
  { timestamps: true },
);

videoPlaylistSchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = model('VideoPlaylist', videoPlaylistSchema);
