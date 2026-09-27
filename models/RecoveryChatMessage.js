const { Schema, model } = require("mongoose");

const CHAT_RETENTION_SECONDS = 180 * 24 * 60 * 60;

// Coach conversation turns. Text is encrypted and expires after 180 days; the
// encrypted rolling summary on RecoveryProfile keeps longer-term memory.
const recoveryChatMessageSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
  role: { type: String, enum: ["user", "coach"], required: true },
  mode: { type: String, enum: ["coach", "sos", "lapse", "crisis"], default: "coach" },
  textEnc: { type: String, required: true },
  risk: { type: String, enum: ["none", "elevated", "crisis"], default: "none" },
  riskType: { type: String, default: "none" },
  suggestedTool: { type: String, default: "none" },
  createdAt: { type: Date, default: Date.now, expires: CHAT_RETENTION_SECONDS },
});

recoveryChatMessageSchema.index({ user: 1, createdAt: -1 });
module.exports = model("RecoveryChatMessage", recoveryChatMessageSchema);
