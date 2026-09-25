const { Schema, model } = require("mongoose");

const WORKOUT_TYPES = ["walking", "running", "cycling", "strength", "hiit", "yoga", "swimming", "sports", "cardio", "other"];

const workoutLogSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
    date: { type: Date, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: WORKOUT_TYPES, default: "other" },
    intensity: { type: String, enum: ["light", "moderate", "vigorous"], default: "moderate" },
    durationMin: { type: Number, min: 1, max: 600, required: true },
    caloriesBurned: { type: Number, min: 0, max: 5000, default: 0 },
    exercises: {
      type: [{
        name: { type: String, trim: true, maxlength: 120, required: true },
        sets: { type: Number, min: 0, max: 50 },
        reps: { type: Number, min: 0, max: 500 },
        weightKg: { type: Number, min: 0, max: 500 },
      }],
      default: [],
    },
    notes: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);

workoutLogSchema.index({ user: 1, date: -1 });
module.exports = model("WorkoutLog", workoutLogSchema);
module.exports.WORKOUT_TYPES = WORKOUT_TYPES;
