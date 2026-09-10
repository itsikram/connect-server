const { Schema, model } = require("mongoose");

const tipSchema = new Schema({
  senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  creatorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  amountCoins: { type: Number, required: true, min: 1 },
  platformFeeCoins: { type: Number, required: true, min: 0 },
  creatorAmountCoins: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ["completed"], default: "completed" },
}, { timestamps: true });

tipSchema.index({ senderId: 1, createdAt: -1 });
tipSchema.index({ creatorId: 1, createdAt: -1 });

module.exports = model("Tip", tipSchema);
