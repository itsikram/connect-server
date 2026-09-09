const assert = require("node:assert/strict");
const test = require("node:test");
const Meal = require("./Meal");
const { Types } = require("mongoose");

test("meal nutrition validation rejects negative and implausible values", async () => {
  const meal = new Meal({
    user: new Types.ObjectId(),
    name: "Test meal", date: new Date(), calories: -1,
    proteinG: 10, carbsG: 20, fatG: 10,
  });
  await assert.rejects(meal.validate(), /calories/);
});

test("meal nutrition validation accepts a confirmed meal", async () => {
  const meal = new Meal({
    user: new Types.ObjectId(),
    name: "Oats", date: new Date(), calories: 350,
    proteinG: 12, carbsG: 55, fatG: 8,
  });
  await meal.validate();
});
