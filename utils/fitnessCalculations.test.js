const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateNutrition } = require("./fitnessCalculations");

test("Mifflin-St Jeor produces deterministic BMR, TDEE and macros", () => {
  const result = calculateNutrition({
    sex: "male", age: 30, heightCm: 180, weightKg: 80,
    activityLevel: "moderate", goal: "maintain",
  });
  assert.equal(result.bmr, 1780);
  assert.equal(result.tdee, 2759);
  assert.equal(result.targetCalories, 2759);
  assert.equal(result.macros.proteinG, 128);
  assert.equal(result.safety.appliedMinimum, false);
});

test("calorie floor prevents unsafe aggressive weight loss targets", () => {
  const result = calculateNutrition({
    sex: "female", age: 80, heightCm: 150, weightKg: 45,
    activityLevel: "sedentary", goal: "lose",
  });
  assert.equal(result.targetCalories, 1200);
  assert.equal(result.safety.appliedMinimum, true);
});

test("invalid profile values are rejected", () => {
  assert.throws(() => calculateNutrition({
    sex: "male", age: 10, heightCm: 180, weightKg: 80,
  }), /age must be between/);
});

const {
  calculateHealthTargets,
  estimateWorkoutCalories,
  projectGoal,
  calculateStreak,
  calculateDailyScore,
} = require("./fitnessCalculations");

test("pace changes the calorie adjustment for weight loss", () => {
  const base = { sex: "male", age: 30, heightCm: 180, weightKg: 80, activityLevel: "moderate", goal: "lose" };
  assert.equal(calculateNutrition({ ...base, pace: "relaxed" }).targetCalories, 2509);
  assert.equal(calculateNutrition(base).targetCalories, 2259);
  assert.equal(calculateNutrition({ ...base, pace: "aggressive" }).targetCalories, 2009);
});

test("health targets derive BMI, hydration and step goals", () => {
  const targets = calculateHealthTargets({ heightCm: 180, weightKg: 81, activityLevel: "moderate" });
  assert.equal(targets.bmi, 25);
  assert.equal(targets.bmiCategory, "overweight");
  assert.equal(targets.waterTargetMl, 2850);
  assert.equal(targets.stepTarget, 9000);
  assert.deepEqual(targets.healthyWeightRangeKg, { min: 59.9, max: 80.7 });
});

test("workout calories use MET x kg x hours", () => {
  assert.equal(estimateWorkoutCalories({ type: "running", intensity: "moderate", durationMin: 30, weightKg: 70 }), 343);
  assert.equal(estimateWorkoutCalories({ type: "unknown", durationMin: 60, weightKg: 70 }), 315);
  assert.equal(estimateWorkoutCalories({ type: "yoga", durationMin: 0, weightKg: 70 }), 0);
});

test("goal projection reports percent and weeks left", () => {
  const result = projectGoal({ startWeightKg: 90, currentWeightKg: 85, targetWeightKg: 80, goal: "lose", pace: "standard", now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(result.percent, 50);
  assert.equal(result.remainingKg, 5);
  assert.equal(result.weeklyKg, 0.5);
  assert.equal(result.weeksLeft, 10);
  assert.equal(projectGoal({ startWeightKg: 80, currentWeightKg: 80, targetWeightKg: 80, goal: "maintain" }), null);
});

test("streak counts back from today or yesterday", () => {
  assert.equal(calculateStreak(["2026-03-10", "2026-03-09", "2026-03-08", "2026-03-06"], "2026-03-10"), 3);
  assert.equal(calculateStreak(["2026-03-09", "2026-03-08"], "2026-03-10"), 2);
  assert.equal(calculateStreak(["2026-03-07"], "2026-03-10"), 0);
});

test("daily score caps each pillar and penalizes overeating", () => {
  const perfect = calculateDailyScore({ calories: 2000, targetCalories: 2000, proteinG: 150, proteinTarget: 120, waterMl: 3000, waterTarget: 2500, steps: 12000, stepTarget: 9000, activeMinutes: 45, sleepHours: 8, sleepTarget: 8 });
  assert.equal(perfect.score, 100);
  const overate = calculateDailyScore({ calories: 3000, targetCalories: 2000 });
  assert.equal(overate.pillars[0].percent, 0);
  assert.equal(calculateDailyScore({}).score, 0);
});
