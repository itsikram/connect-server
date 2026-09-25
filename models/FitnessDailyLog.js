const { Schema, model } = require("mongoose");

// One document per user per day for habit metrics that are not meals or workouts.
const fitnessDailyLogSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
    date: { type: Date, required: true },
    waterMl: { type: Number, min: 0, max: 10000, default: 0 },
    steps: { type: Number, min: 0, max: 100000, default: 0 },
    sleepHours: { type: Number, min: 0, max: 24, default: 0 },
    mood: { type: Number, min: 1, max: 5 },
  },
  { timestamps: true },
);

fitnessDailyLogSchema.index({ user: 1, date: -1 }, { unique: true });
module.exports = model("FitnessDailyLog", fitnessDailyLogSchema);
