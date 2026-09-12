const { Schema, model } = require("mongoose");

const fitnessProfileSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, unique: true, index: true },
    sex: { type: String, enum: ["male", "female", "other"], required: true },
    age: { type: Number, min: 13, max: 100, required: true },
    heightCm: { type: Number, min: 100, max: 250, required: true },
    weightKg: { type: Number, min: 25, max: 350, required: true },
    activityLevel: { type: String, enum: ["sedentary", "light", "moderate", "very_active", "extra_active"], default: "moderate" },
    goal: { type: String, enum: ["lose", "maintain", "gain"], default: "maintain" },
    targetWeightKg: { type: Number, min: 25, max: 350 },
    targetCalories: Number,
    bmr: Number,
    tdee: Number,
    macros: { proteinG: Number, carbsG: Number, fatG: Number },
    targetNotifications: {
      date: String,
      calories: { type: Boolean, default: false },
      protein: { type: Boolean, default: false },
      weight: { type: Boolean, default: false },
    },
    dietaryPreferences: { type: [String], default: [] },
    allergies: { type: [String], default: [] },
    onboardingCompleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = model("FitnessProfile", fitnessProfileSchema);
