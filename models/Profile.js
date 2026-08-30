const { Schema, model } = require("mongoose");
const User = require("./User");
const config = require("../config/config.json");

let profileSchema = new Schema(
  {
    username: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || (value.length >= 5 && value.length <= 50);
        },
        message: "Username must be between 5 and 50 characters",
      },
      default: "",
    },
    nickname: {
      type: String,
      validate: {
        validator: function (value) {
          return !value || (value.length >= 2 && value.length <= 50);
        },
        message: "Nickname must be between 2 and 50 characters",
      },
      default: "",
    },
    fullName: {
      type: String,
    },
    displayName: {
      type: String,
    },
    banglaName: {
      type: String,
      default: "",
      trim: true,
      index: true, // Create index for faster searches
    },
    coverPic: {
      type: String,
      default: config?.defaultCover,
    },
    profilePic: {
      type: String,
      default: config?.defaultProfile,
    },
    bio: {
      type: String,
      maxLength: 200,
      default: "Hello World, I am a new User",
    },
    friends: [
      {
        type: Schema.Types.ObjectId,
        ref: "Profile",
      },
    ],
    lastEmotion: String,
    lastEmotionText: String,
    lastEmotionEmoji: String,
    lastEmotionConfidence: Number,
    lastEmotionQuality: Number,
    lastLocation: {
      type: Object,
      default: {
        latitude: 0,
        longitude: 0,
        timestamp: Date.now(),
      },
    },
    friendReqs: [
      {
        type: Schema.Types.ObjectId,
        ref: "Profile",
      },
    ],
    workPlaces: [
      {
        type: Object,
      },
    ],
    schools: [
      {
        type: Object,
      },
    ],
    presentAddress: String,
    permanentAddress: String,
    following: [
      {
        type: Schema.Types.ObjectId,
      },
    ],
    blockedUsers: [
      {
        type: Schema.Types.ObjectId,
      },
    ],
    settings: {
      type: Object,
    },
    isOfficial: {
      type: Boolean,
      default: false,
      index: true,
    },
    lastWeeklyRecapAt: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    lastActive: {
      type: Date,
      default: null,
      index: true,
    },
    deviceTokens: [
      {
        type: String,
      },
    ],
    browserIds: [
      {
        browserId: {
          type: String,
          unique: true,
        },
        userAgent: String,
        lastActive: {
          type: Date,
          default: Date.now,
        },
        isActive: {
          type: Boolean,
          default: true,
        },
      },
    ],
    // Web Push subscriptions (iOS Home Screen / PWA background notifications)
    webPushSubscriptions: [
      {
        endpoint: { type: String, required: true },
        keys: {
          p256dh: { type: String, required: true },
          auth: { type: String, required: true },
        },
        userAgent: String,
        browserId: String,
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date, default: Date.now },
      },
    ],
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

let Profile = model("Profile", profileSchema);

module.exports = Profile;
