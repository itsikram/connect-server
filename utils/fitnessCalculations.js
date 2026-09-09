const ACTIVITY_FACTORS = Object.freeze({
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
});

const GOAL_ADJUSTMENTS = Object.freeze({
  lose: -500,
  maintain: 0,
  gain: 300,
});

const round = (value) => Math.round(value * 10) / 10;

const assertFinite = (value, field) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a number`);
  return number;
};

/**
 * Mifflin-St Jeor using metric units. Calories are intentionally conservative:
 * no goal adjustment may take a person below a sex-specific minimum.
 */
const calculateNutrition = ({
  sex,
  age,
  heightCm,
  weightKg,
  activityLevel = "moderate",
  goal = "maintain",
}) => {
  const normalizedSex = String(sex || "").toLowerCase();
  if (!["male", "female", "other"].includes(normalizedSex)) {
    throw new Error("sex must be male, female, or other");
  }
  const normalizedActivity = String(activityLevel || "").toLowerCase();
  const normalizedGoal = String(goal || "").toLowerCase();
  if (!ACTIVITY_FACTORS[normalizedActivity]) throw new Error("Invalid activity level");
  if (!Object.prototype.hasOwnProperty.call(GOAL_ADJUSTMENTS, normalizedGoal)) throw new Error("Invalid goal");

  const years = assertFinite(age, "age");
  const height = assertFinite(heightCm, "heightCm");
  const weight = assertFinite(weightKg, "weightKg");
  if (years < 13 || years > 100) throw new Error("age must be between 13 and 100");
  if (height < 100 || height > 250) throw new Error("heightCm must be between 100 and 250");
  if (weight < 25 || weight > 350) throw new Error("weightKg must be between 25 and 350");

  const sexOffset = normalizedSex === "male" ? 5 : normalizedSex === "female" ? -161 : -78;
  const bmr = 10 * weight + 6.25 * height - 5 * years + sexOffset;
  const tdee = bmr * ACTIVITY_FACTORS[normalizedActivity];
  const minimumCalories = normalizedSex === "female" ? 1200 : 1500;
  const targetCalories = Math.max(minimumCalories, tdee + GOAL_ADJUSTMENTS[normalizedGoal]);

  const protein = Math.max(weight * (normalizedGoal === "lose" ? 1.8 : 1.6), weight * 0.8);
  const fat = Math.max((targetCalories * 0.25) / 9, weight * 0.6);
  const carbs = Math.max(0, (targetCalories - protein * 4 - fat * 9) / 4);

  return {
    bmr: round(bmr),
    tdee: round(tdee),
    targetCalories: Math.round(targetCalories),
    macros: {
      proteinG: round(protein),
      carbsG: round(carbs),
      fatG: round(fat),
    },
    safety: {
      minimumCalories,
      appliedMinimum: targetCalories === minimumCalories && tdee + GOAL_ADJUSTMENTS[normalizedGoal] < minimumCalories,
    },
  };
};

module.exports = { ACTIVITY_FACTORS, GOAL_ADJUSTMENTS, calculateNutrition };
