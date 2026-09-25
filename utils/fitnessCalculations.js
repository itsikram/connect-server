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

// Daily calorie adjustment per goal and pace. "standard" matches GOAL_ADJUSTMENTS:
// roughly 0.5 kg/week loss or 0.3 kg/week lean gain.
const PACE_ADJUSTMENTS = Object.freeze({
  lose: { relaxed: -250, standard: -500, aggressive: -750 },
  maintain: { relaxed: 0, standard: 0, aggressive: 0 },
  gain: { relaxed: 150, standard: 300, aggressive: 450 },
});

// Metabolic equivalents (MET) by workout type and intensity, rounded from the
// Compendium of Physical Activities.
const WORKOUT_METS = Object.freeze({
  walking: { light: 2.8, moderate: 3.5, vigorous: 5 },
  running: { light: 7, moderate: 9.8, vigorous: 11.5 },
  cycling: { light: 4, moderate: 6.8, vigorous: 10 },
  strength: { light: 3.5, moderate: 5, vigorous: 6 },
  hiit: { light: 6, moderate: 8, vigorous: 10 },
  yoga: { light: 2.5, moderate: 3, vigorous: 4 },
  swimming: { light: 5, moderate: 7, vigorous: 9.8 },
  sports: { light: 4.5, moderate: 6.5, vigorous: 8 },
  cardio: { light: 4, moderate: 6, vigorous: 8 },
  other: { light: 3, moderate: 4.5, vigorous: 6 },
});

const STEP_TARGETS = Object.freeze({
  sedentary: 6000,
  light: 7500,
  moderate: 9000,
  very_active: 10000,
  extra_active: 12000,
});

const WORKOUT_TARGETS = Object.freeze({
  sedentary: 2,
  light: 3,
  moderate: 4,
  very_active: 5,
  extra_active: 6,
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
  pace = "standard",
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
  const normalizedPace = Object.prototype.hasOwnProperty.call(PACE_ADJUSTMENTS.lose, pace) ? pace : "standard";
  const adjustment = PACE_ADJUSTMENTS[normalizedGoal][normalizedPace];
  const targetCalories = Math.max(minimumCalories, tdee + adjustment);

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
      appliedMinimum: targetCalories === minimumCalories && tdee + adjustment < minimumCalories,
    },
  };
};

const bmiCategory = (bmi) => {
  if (bmi < 18.5) return "underweight";
  if (bmi < 25) return "healthy";
  if (bmi < 30) return "overweight";
  return "obese";
};

/** Daily habit targets derived from the body profile. */
const calculateHealthTargets = ({ heightCm, weightKg, activityLevel = "moderate" }) => {
  const height = Number(heightCm) / 100;
  const weight = Number(weightKg);
  const bmi = height > 0 && weight > 0 ? round(weight / (height * height)) : null;
  const activityBonus = ["very_active", "extra_active"].includes(activityLevel) ? 500 : 0;
  return {
    bmi,
    bmiCategory: bmi ? bmiCategory(bmi) : null,
    healthyWeightRangeKg: height > 0 ? { min: round(18.5 * height * height), max: round(24.9 * height * height) } : null,
    // ~35 ml per kg is a common general-wellness hydration guideline.
    waterTargetMl: Math.round(Math.min(4500, Math.max(1500, weight * 35 + activityBonus)) / 50) * 50,
    stepTarget: STEP_TARGETS[activityLevel] || 8000,
    weeklyWorkoutTarget: WORKOUT_TARGETS[activityLevel] || 3,
    sleepTargetHours: 8,
  };
};

/** calories = MET x body weight (kg) x hours */
const estimateWorkoutCalories = ({ type = "other", intensity = "moderate", durationMin, weightKg }) => {
  const mets = WORKOUT_METS[type] || WORKOUT_METS.other;
  const met = mets[intensity] || mets.moderate;
  const minutes = Number(durationMin);
  const weight = Number(weightKg) || 70;
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round(met * weight * (minutes / 60));
};

/**
 * Progress toward a target weight and a projected finish date based on the
 * daily calorie adjustment (7700 kcal ~= 1 kg of body mass).
 */
const projectGoal = ({ startWeightKg, currentWeightKg, targetWeightKg, goal, pace = "standard", now = new Date() }) => {
  const start = Number(startWeightKg);
  const current = Number(currentWeightKg);
  const target = Number(targetWeightKg);
  if (!target || !start || !current || !["lose", "gain"].includes(goal)) return null;
  const totalChange = Math.abs(target - start);
  const done = goal === "lose" ? start - current : current - start;
  const percent = totalChange > 0 ? Math.max(0, Math.min(100, Math.round((done / totalChange) * 100))) : 100;
  const remainingKg = round(Math.max(0, goal === "lose" ? current - target : target - current));
  const adjustment = Math.abs(PACE_ADJUSTMENTS[goal][pace] ?? PACE_ADJUSTMENTS[goal].standard);
  const weeklyKg = round((adjustment * 7) / 7700);
  const weeksLeft = weeklyKg > 0 ? Math.ceil(remainingKg / weeklyKg) : null;
  const eta = weeksLeft !== null ? new Date(new Date(now).getTime() + weeksLeft * 7 * 86400000) : null;
  return { startWeightKg: start, currentWeightKg: current, targetWeightKg: target, percent, remainingKg, weeklyKg, weeksLeft, eta, reached: remainingKg === 0 };
};

/** Consecutive days with any log, ending today (or yesterday if today has no log yet). */
const calculateStreak = (dayKeys, todayKey) => {
  const days = new Set(dayKeys);
  const cursor = new Date(`${todayKey}T00:00:00Z`);
  if (!days.has(todayKey)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
};

/**
 * 0-100 daily score. Each pillar is capped at its weight so over-eating never
 * scores higher: nutrition rewards landing within 10% of the calorie target.
 */
const calculateDailyScore = ({
  calories, targetCalories, proteinG, proteinTarget, waterMl, waterTarget,
  steps, stepTarget, activeMinutes, sleepHours, sleepTarget,
}) => {
  const ratio = (value, target) => (target > 0 ? Math.min(1, Math.max(0, Number(value) || 0) / target) : 0);
  const calorieRatio = targetCalories > 0 ? (Number(calories) || 0) / targetCalories : 0;
  const calorieScore = calorieRatio === 0 ? 0 : Math.max(0, 1 - Math.max(0, Math.abs(1 - calorieRatio) - 0.1) * 2.5);
  const pillars = [
    { key: "nutrition", weight: 25, value: calorieScore },
    { key: "protein", weight: 15, value: ratio(proteinG, proteinTarget) },
    { key: "hydration", weight: 15, value: ratio(waterMl, waterTarget) },
    { key: "steps", weight: 15, value: ratio(steps, stepTarget) },
    { key: "activity", weight: 15, value: ratio(activeMinutes, 30) },
    { key: "sleep", weight: 15, value: ratio(sleepHours, sleepTarget) },
  ];
  return {
    score: Math.round(pillars.reduce((sum, pillar) => sum + pillar.weight * pillar.value, 0)),
    pillars: pillars.map((pillar) => ({ key: pillar.key, weight: pillar.weight, percent: Math.round(pillar.value * 100) })),
  };
};

module.exports = {
  ACTIVITY_FACTORS,
  GOAL_ADJUSTMENTS,
  PACE_ADJUSTMENTS,
  WORKOUT_METS,
  calculateNutrition,
  calculateHealthTargets,
  estimateWorkoutCalories,
  projectGoal,
  calculateStreak,
  calculateDailyScore,
};
