const { Schema, model } = require("mongoose");

const mealSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
    date: { type: Date, required: true, index: true },
    mealType: { type: String, enum: ["breakfast", "lunch", "dinner", "snack"], default: "snack" },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    servings: { type: Number, min: 0.1, max: 20, default: 1 },
    calories: { type: Number, min: 0, max: 10000, required: true },
    proteinG: { type: Number, min: 0, max: 500, required: true },
    carbsG: { type: Number, min: 0, max: 1000, required: true },
    fatG: { type: Number, min: 0, max: 500, required: true },
    fiberG: { type: Number, min: 0, max: 300, default: 0 },
    notes: { type: String, trim: true, maxlength: 1000 },
    source: { type: String, enum: ["manual", "gemini", "placeholder"], default: "manual" },
    imageUrl: { type: String, trim: true, maxlength: 2000 },
    analysis: { type: Schema.Types.Mixed },
    foods: {
      type: [{
        name: { type: String, trim: true, maxlength: 160 },
        quantity: { type: Number, min: 0 },
        unit: { type: String, trim: true, maxlength: 30 },
        calories: { type: Number, min: 0, max: 10000 },
        proteinG: { type: Number, min: 0, max: 500 },
        carbsG: { type: Number, min: 0, max: 1000 },
        fatG: { type: Number, min: 0, max: 500 },
      }],
      default: [],
    },
    userConfirmedAt: { type: Date },
  },
  { timestamps: true },
);

mealSchema.index({ user: 1, date: -1 });
module.exports = model("Meal", mealSchema);
