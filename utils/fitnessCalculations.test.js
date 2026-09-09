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
