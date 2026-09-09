const LIMITS = Object.freeze({
  calories: { min: 0, max: 10000 },
  proteinG: { min: 0, max: 500 },
  carbsG: { min: 0, max: 1000 },
  fatG: { min: 0, max: 500 },
  fiberG: { min: 0, max: 300 },
});

const normalizeNutrition = (value, fallbackName = "") => {
  if (!value || typeof value !== "object") {
    throw new Error("Food analysis must be an object");
  }

  const name = String(value.name || fallbackName).trim();
  if (!name || name.length > 160) throw new Error("Food name is required");

  const result = { name, serving: String(value.serving || "1 serving").trim() };
  for (const [field, limits] of Object.entries(LIMITS)) {
    const number = Number(value[field]);
    if (!Number.isFinite(number) || number < limits.min || number > limits.max) {
      throw new Error(`Invalid ${field}`);
    }
    result[field] = Math.round(number * 10) / 10;
  }
  return result;
};

module.exports = { LIMITS, normalizeNutrition };
