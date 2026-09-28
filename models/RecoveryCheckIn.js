const { Schema, model } = require("mongoose");
const { HALT_KEYS, SUBSTANCE_KEYS, SYMPTOM_KEYS } = require("../utils/recoveryContent");

// One check-in per user per local day ("YYYY-MM-DD" in the user's timezone).
const recoveryCheckInSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    used: {
      type: [{ substance: { type: String, enum: SUBSTANCE_KEYS }, amount: { type: Number, min: 0, max: 1000 }, _id: false }],
      default: [],
    },
    mood: { type: Number, min: 1, max: 5, required: true },
    craving: { type: Number, min: 0, max: 10, required: true },
    stress: { type: Number, min: 1, max: 5 },
    sleepHours: { type: Number, min: 0, max: 24 },
    halt: { type: [{ type: String, enum: HALT_KEYS }], default: [] },
    triggers: { type: [String], default: [] },
    symptoms: { type: [{ type: String, enum: SYMPTOM_KEYS }], default: [] },
    noteEnc: { type: String, default: "" },
    reflectionEnc: { type: String, default: "" },
    risk: { type: String, enum: ["none", "elevated", "crisis"], default: "none" },
  },
  { timestamps: true },
);

recoveryCheckInSchema.index({ user: 1, day: -1 }, { unique: true });
module.exports = model("RecoveryCheckIn", recoveryCheckInSchema);
