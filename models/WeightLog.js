const { Schema, model } = require("mongoose");

const weightLogSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
    date: { type: Date, required: true },
    weightKg: { type: Number, min: 25, max: 350, required: true },
    bodyFatPercent: { type: Number, min: 1, max: 80 },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

weightLogSchema.index({ user: 1, date: -1 }, { unique: true });
module.exports = model("WeightLog", weightLogSchema);
