const { Schema, model } = require("mongoose");
const { SUBSTANCE_KEYS } = require("../utils/recoveryContent");

// Free-text fields ending in "Enc" hold values encrypted with utils/recoveryCrypto.
const substanceSchema = new Schema(
  {
    key: { type: String, enum: SUBSTANCE_KEYS, required: true },
    customName: { type: String, trim: true, maxlength: 60 },
    primary: { type: Boolean, default: false },
    amountPerDay: { type: Number, min: 0, max: 1000, default: 0 },
    daysPerWeek: { type: Number, min: 0, max: 7, default: 7 },
    costPerUnit: { type: Number, min: 0, max: 1000000, default: 0 },
    yearsUsing: { type: Number, min: 0, max: 80 },
    wakeUse: { type: String, enum: ["", "5min", "30min", "60min", "later"], default: "" },
    approach: { type: String, enum: ["now", "date", "taper", "doctor"], default: "now" },
    quitDate: { type: Date, required: true },
    // The current streak restarts after a slip; longest and banked days never shrink.
    streakStart: { type: Date, required: true },
    longestStreakDays: { type: Number, min: 0, default: 0 },
    bankedCleanDays: { type: Number, min: 0, default: 0 },
    screener: {
      tool: { type: String, trim: true, maxlength: 20 },
      score: { type: Number, min: 0, max: 40 },
      severity: { type: String, enum: ["", "low", "moderate", "high"], default: "" },
    },
  },
  { _id: false },
);

const recoveryProfileSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, unique: true },
    substances: {
      type: [substanceSchema],
      validate: { validator: (items) => items.length >= 1 && items.length <= 6, message: "Track between 1 and 6 substances" },
    },
    readiness: {
      importance: { type: Number, min: 0, max: 10, default: 8 },
      confidence: { type: Number, min: 0, max: 10, default: 5 },
    },
    reasonKeys: { type: [String], default: [] },
    reasonsEnc: { type: String, default: "" },
    letterEnc: { type: String, default: "" },
    triggers: { type: [String], default: [] },
    riskHours: { type: [Number], default: [] },
    supportContactsEnc: { type: String, default: "" },
    planEnc: { type: String, default: "" },
    planSource: { type: String, enum: ["", "gemini", "curated"], default: "" },
    planGeneratedAt: { type: Date, default: null },
    points: { type: Number, min: 0, default: 0 },
    badges: { type: [{ key: String, at: Date, _id: false }], default: [] },
    daily: {
      dayKey: { type: String, default: "" },
      noteEnc: { type: String, default: "" },
    },
    chatSummaryEnc: { type: String, default: "" },
    chatMessagesSinceSummary: { type: Number, min: 0, default: 0 },
    lastCrisisAt: { type: Date, default: null },
    settings: {
      aiEnabled: { type: Boolean, default: true },
      discreet: { type: Boolean, default: true },
      riskNudges: { type: Boolean, default: false },
    },
    language: { type: String, enum: ["auto", "en", "bn"], default: "auto" },
    timezone: { type: String, trim: true, maxlength: 80, default: "Asia/Dhaka" },
    currency: { type: String, trim: true, maxlength: 8, default: "BDT" },
    onboardingCompleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = model("RecoveryProfile", recoveryProfileSchema);
