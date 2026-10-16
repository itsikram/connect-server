const assert = require("node:assert/strict");
const test = require("node:test");
const { validateDoc } = require("../controllers/fitnessController");

// Meal validation moved from the Mongoose schema to the fitness controller (MySQL/Prisma).
test("meal nutrition validation rejects negative and implausible values", () => {
  assert.throws(() => validateDoc("Meal", {
    name: "Test meal", date: new Date(), calories: -1,
    proteinG: 10, carbsG: 20, fatG: 10,
  }), /calories/);
});

test("meal nutrition validation accepts a confirmed meal", () => {
  validateDoc("Meal", {
    name: "Oats", date: new Date(), calories: 350,
    proteinG: 12, carbsG: 55, fatG: 8,
  });
});
