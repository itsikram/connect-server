const { Schema, model } = require("mongoose");

const payoutRequestSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  method: {
    type: String,
    enum: ["mobile_recharge", "bkash", "nagad"],
    required: true,
  },
  payoutAddress: { type: String, trim: true, required: true, maxlength: 120 },
  recipientName: { type: String, trim: true, required: true, maxlength: 120 },
  phoneNumber: { type: String, trim: true, required: true, maxlength: 30 },
  amountCoins: { type: Number, required: true, min: 1 },
  amountBDT: { type: Number, required: true, min: 0 },
  exchangeRate: { type: Number, required: true, min: 0 },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  rejectionReason: { type: String, default: null, maxlength: 500 },
  reviewedAt: { type: Date, default: null },
  reviewedByAdminId: { type: String, default: null },
  auditLog: [{
    action: { type: String, enum: ["approved", "rejected"], required: true },
    adminId: { type: String, required: true },
    timestamp: { type: Date, required: true },
  }],
}, { timestamps: true });

payoutRequestSchema.index({ status: 1, createdAt: -1 });
payoutRequestSchema.index({ userId: 1, status: 1 });

module.exports = model("PayoutRequest", payoutRequestSchema);
