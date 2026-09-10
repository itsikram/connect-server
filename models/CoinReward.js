const { Schema, model } = require("mongoose");

const coinRewardSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  actionKey: { type: String, required: true, trim: true, maxlength: 80 },
  referenceId: { type: String, required: true, trim: true, maxlength: 120 },
  coins: { type: Number, required: true, min: 1 },
}, { timestamps: true });

coinRewardSchema.index({ userId: 1, actionKey: 1, referenceId: 1 }, { unique: true });

module.exports = model("CoinReward", coinRewardSchema);
