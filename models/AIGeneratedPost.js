const { Schema, model } = require("mongoose");

const aiGeneratedPostSchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: "Profile", required: true },
    post: { type: Schema.Types.ObjectId, ref: "Post", default: null },
    category: { type: String, required: true, index: true },
    topic: { type: String, required: true, index: true },
    language: { type: String, required: true, index: true },
    contentType: String,
    caption: { type: String, required: true, maxlength: 500 },
    hashtags: { type: [String], default: [] },
    imagePrompt: String,
    imageUrl: String,
    imageStatus: { type: String, enum: ["pending", "ready", "failed", "disabled"], default: "pending" },
    imageError: String,
    status: {
      type: String,
      enum: ["draft", "published", "failed", "deleted"],
      default: "draft",
      index: true,
    },
    error: String,
    provider: String,
    model: String,
    personalization: {
      categories: { type: [String], default: [] },
      topics: { type: [String], default: [] },
    },
    generatedAt: { type: Date, default: Date.now, index: true },
    publishedAt: Date,
    scheduledFor: Date,
  },
  { timestamps: true },
);

aiGeneratedPostSchema.index({ topic: 1, generatedAt: -1 });

module.exports = model("AIGeneratedPost", aiGeneratedPostSchema);
