const { Schema, model } = require("mongoose");

const aiChatSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "Profile",
      required: true,
      unique: true,
      index: true,
    },
    messages: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    sessionTimestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

module.exports = model("AIChat", aiChatSchema);
