const mongoose = require('mongoose');

const ytDownloadProgressSchema = new mongoose.Schema(
    {
        _id: { type: String },
        stage: String,
        status: String,
        pct: Number,
        file_url: String,
        title: String,
        download_title: String,
        watch_posted: Boolean,
        watch_caption: String,
        error: String,
        source: String,
        storage: String,
    },
    { timestamps: true }
);

ytDownloadProgressSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7200 });

module.exports =
    mongoose.models.YtDownloadProgress ||
    mongoose.model('YtDownloadProgress', ytDownloadProgressSchema);
