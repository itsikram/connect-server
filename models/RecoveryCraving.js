const { Schema, model } = require("mongoose");
const { SUBSTANCE_KEYS, TOOL_KEYS, TRIGGER_KEYS } = require("../utils/recoveryContent");

// One SOS session. `clientId` makes offline-queued uploads idempotent.
const recoveryCravingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
    clientId: { type: String, required: true, trim: true, maxlength: 64 },
    at: { type: Date, required: true },
    substance: { type: String, enum: SUBSTANCE_KEYS },
    intensityStart: { type: Number, min: 1, max: 10, required: true },
    intensityEnd: { type: Number, min: 0, max: 10 },
    trigger: { type: String, enum: ["", ...TRIGGER_KEYS], default: "" },
    tools: { type: [{ type: String, enum: TOOL_KEYS }], default: [] },
    durationSec: { type: Number, min: 0, max: 24 * 3600, default: 0 },
    outcome: { type: String, enum: ["resisted", "used", "unsure"], default: "unsure" },
  },
  { timestamps: true },
);

recoveryCravingSchema.index({ user: 1, clientId: 1 }, { unique: true });
recoveryCravingSchema.index({ user: 1, at: -1 });
module.exports = model("RecoveryCraving", recoveryCravingSchema);
