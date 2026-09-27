const { Schema, model } = require("mongoose");
const { SUBSTANCE_KEYS, TRIGGER_KEYS } = require("../utils/recoveryContent");

// A slip: use after quitting. It restarts the current streak for that substance.
const recoveryLapseSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
    at: { type: Date, required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    substance: { type: String, enum: SUBSTANCE_KEYS, required: true },
    amount: { type: Number, min: 0, max: 1000, default: 0 },
    trigger: { type: String, enum: ["", ...TRIGGER_KEYS], default: "" },
    feelingBefore: { type: String, trim: true, maxlength: 40, default: "" },
    contextEnc: { type: String, default: "" },
    debriefEnc: { type: String, default: "" },
    restart: { type: String, enum: ["continue", "new_date"], default: "continue" },
    source: { type: String, enum: ["lapse", "checkin", "sos"], default: "lapse" },
  },
  { timestamps: true },
);

recoveryLapseSchema.index({ user: 1, at: -1 });
module.exports = model("RecoveryLapse", recoveryLapseSchema);
