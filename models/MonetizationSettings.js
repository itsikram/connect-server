const { Schema, model } = require("mongoose");
const { DEFAULT_FEATURE_FLAGS } = require("../config/featureFlags");

const monetizationSettingsSchema = new Schema(
  {
    singletonKey: {
      type: String,
      unique: true,
      default: "default",
    },
    featureFlags: {
      type: Map,
      of: Boolean,
      default: () => ({ ...DEFAULT_FEATURE_FLAGS }),
    },
    paymentNumbers: {
      bkash: { type: String, default: "", trim: true },
      nagad: { type: String, default: "", trim: true },
    },
    subscriptionTiers: {
      plus_basic: {
        priceBDT: { type: Number, default: 49, min: 0 },
        durationDays: { type: Number, default: 30, min: 1 },
        enabled: { type: Boolean, default: true },
      },
      plus_pro: {
        priceBDT: { type: Number, default: 149, min: 0 },
        durationDays: { type: Number, default: 30, min: 1 },
        enabled: { type: Boolean, default: true },
      },
    },
    coinPacks: [{
      coins: { type: Number, required: true, min: 1 },
      priceBDT: { type: Number, required: true, min: 0 },
      enabled: { type: Boolean, default: true },
    }],
    tipping: {
      platformFeePercent: { type: Number, default: 20, min: 0, max: 100 },
    },
    updatedByAdminId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

module.exports = model("MonetizationSettings", monetizationSettingsSchema);
