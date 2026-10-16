const axios = require("axios");
const { prisma, newId, isValidId, jsonArray, jsonObject } = require("../utils/db");
const {
  calculateNutrition,
  calculateHealthTargets,
  estimateWorkoutCalories,
  projectGoal,
  calculateStreak,
  calculateDailyScore,
} = require("../utils/fitnessCalculations");
const { loadAiSettings, getProviderKey, isProviderEnabled } = require("../utils/aiSettingsStore");
const { normalizeNutrition } = require("../utils/fitnessNutrition");
const { sendPushToProfile } = require("../utils/pushNotifications");

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  date.setHours(0, 0, 0, 0);
  return date;
};
const endOfDay = (value = new Date()) => new Date(startOfDay(value).getTime() + 86400000);
const owner = (req) => (req.profile?._id != null ? String(req.profile._id) : undefined);
const badRequest = (res, message) => res.status(400).json({ success: false, message });
const handleError = (res, error) => {
  if (error?.name === "ValidationError" || error?.name === "CastError") return badRequest(res, error.message);
  console.error("Fitness request failed:", error);
  return res.status(500).json({ success: false, message: "Fitness request failed" });
};
const isProviderTimeout = (error) => error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT";
const pick = (source, keys) => keys.reduce((result, key) => {
  if (source[key] !== undefined) result[key] = source[key];
  return result;
}, {});
const dayKey = (value) => {
  const date = startOfDay(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const PROFILE_FIELDS = ["sex", "age", "heightCm", "weightKg", "activityLevel", "goal", "pace", "timezone", "targetWeightKg", "dietaryPreferences", "allergies", "onboardingCompleted"];
const isValidTimezone = (value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch (_) {
    return false;
  }
};

// ── Validation formerly done by the Mongoose schemas (enums, ranges, required) ──
const WORKOUT_TYPES = ["walking", "running", "cycling", "strength", "hiit", "yoga", "swimming", "sports", "cardio", "other"];
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCHEMAS = {
  FitnessProfile: {
    sex: { type: "string", enum: ["male", "female", "other"], required: true },
    age: { type: "number", integer: true, min: 13, max: 100, required: true },
    heightCm: { type: "number", min: 100, max: 250, required: true },
    weightKg: { type: "number", min: 25, max: 350, required: true },
    activityLevel: { type: "string", enum: ["sedentary", "light", "moderate", "very_active", "extra_active"] },
    goal: { type: "string", enum: ["lose", "maintain", "gain"] },
    pace: { type: "string", enum: ["relaxed", "standard", "aggressive"] },
    startWeightKg: { type: "number", min: 25, max: 350 },
    timezone: { type: "string", trim: true, maxlength: 80 },
    targetWeightKg: { type: "number", min: 25, max: 350 },
    dietaryPreferences: { type: "stringArray", default: () => [] },
    allergies: { type: "stringArray", default: () => [] },
    onboardingCompleted: { type: "boolean" },
  },
  Meal: {
    date: { type: "date", required: true },
    mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
    name: { type: "string", required: true, trim: true, maxlength: 160 },
    servings: { type: "number", min: 0.1, max: 20 },
    calories: { type: "number", min: 0, max: 10000, required: true },
    proteinG: { type: "number", min: 0, max: 500, required: true },
    carbsG: { type: "number", min: 0, max: 1000, required: true },
    fatG: { type: "number", min: 0, max: 500, required: true },
    fiberG: { type: "number", min: 0, max: 300 },
    notes: { type: "string", trim: true, maxlength: 1000 },
    source: { type: "string", enum: ["manual", "gemini", "placeholder"] },
    imageUrl: { type: "string", trim: true, maxlength: 2000 },
    analysis: { type: "json" },
    foods: {
      type: "subdocs",
      default: () => [],
      of: {
        name: { type: "string", trim: true, maxlength: 160 },
        quantity: { type: "number", min: 0 },
        unit: { type: "string", trim: true, maxlength: 30 },
        calories: { type: "number", min: 0, max: 10000 },
        proteinG: { type: "number", min: 0, max: 500 },
        carbsG: { type: "number", min: 0, max: 1000 },
        fatG: { type: "number", min: 0, max: 500 },
      },
    },
    userConfirmedAt: { type: "date" },
  },
  WeightLog: {
    date: { type: "date", required: true },
    weightKg: { type: "number", min: 25, max: 350, required: true },
    bodyFatPercent: { type: "number", min: 1, max: 80 },
    note: { type: "string", trim: true, maxlength: 500 },
  },
  Reminder: {
    title: { type: "string", required: true, trim: true, maxlength: 120 },
    type: { type: "string", enum: ["meal", "water", "workout", "weight", "custom"] },
    time: { type: "string", required: true, match: HH_MM },
    timezone: { type: "string", trim: true, maxlength: 80 },
    days: {
      type: "numberArray",
      default: () => [0, 1, 2, 3, 4, 5, 6],
      validate: (days) => days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6),
      validateMessage: "days must contain weekdays from 0 to 6",
    },
    enabled: { type: "boolean" },
    message: { type: "string", trim: true, maxlength: 300 },
    notificationId: { type: "string", trim: true },
    autoKey: { type: "string", trim: true },
  },
  WorkoutLog: {
    date: { type: "date", required: true },
    name: { type: "string", required: true, trim: true, maxlength: 120 },
    type: { type: "string", enum: WORKOUT_TYPES },
    intensity: { type: "string", enum: ["light", "moderate", "vigorous"] },
    durationMin: { type: "number", min: 1, max: 600, required: true },
    caloriesBurned: { type: "number", min: 0, max: 5000 },
    exercises: {
      type: "subdocs",
      default: () => [],
      of: {
        name: { type: "string", trim: true, maxlength: 120, required: true },
        sets: { type: "number", min: 0, max: 50 },
        reps: { type: "number", min: 0, max: 500 },
        weightKg: { type: "number", min: 0, max: 500 },
      },
    },
    notes: { type: "string", trim: true, maxlength: 1000 },
  },
  FitnessDailyLog: {
    date: { type: "date", required: true },
    waterMl: { type: "number", min: 0, max: 10000 },
    steps: { type: "number", integer: true, min: 0, max: 100000 },
    sleepHours: { type: "number", min: 0, max: 24 },
    mood: { type: "number", integer: true, min: 1, max: 5 },
  },
};

const validationError = (model, path, message) =>
  Object.assign(new Error(`${model} validation failed: ${path}: ${message}`), { name: "ValidationError" });
const castError = (model, path, kind, value) =>
  Object.assign(new Error(`Cast to ${kind} failed for value "${value}" (type ${typeof value}) at path "${path}" for model "${model}"`), { name: "CastError" });

const castBoolean = (model, path, value) => {
  if (typeof value === "boolean") return value;
  if ([1, "1", "true", "yes"].includes(value)) return true;
  if ([0, "0", "false", "no"].includes(value)) return false;
  throw castError(model, path, "Boolean", value);
};

function castValue(model, path, spec, value) {
  if (value === null || (value === "" && spec.type !== "string")) {
    if (spec.required) throw validationError(model, path, `Path \`${path}\` is required.`);
    return null;
  }
  switch (spec.type) {
    case "number": {
      let number = typeof value === "number" ? value : Number(value);
      if (typeof value === "boolean" || !Number.isFinite(number)) throw castError(model, path, "Number", value);
      if (spec.integer) number = Math.round(number);
      if (spec.min !== undefined && number < spec.min) throw validationError(model, path, `Path \`${path}\` (${number}) is less than minimum allowed value (${spec.min}).`);
      if (spec.max !== undefined && number > spec.max) throw validationError(model, path, `Path \`${path}\` (${number}) is more than maximum allowed value (${spec.max}).`);
      return number;
    }
    case "string": {
      if (typeof value === "object") throw castError(model, path, "string", value);
      let text = String(value);
      if (spec.trim) text = text.trim();
      if (spec.required && !text) throw validationError(model, path, `Path \`${path}\` is required.`);
      if (spec.enum && !spec.enum.includes(text)) throw validationError(model, path, `\`${text}\` is not a valid enum value for path \`${path}\`.`);
      if (spec.maxlength !== undefined && text.length > spec.maxlength) throw validationError(model, path, `Path \`${path}\` (\`${text}\`) is longer than the maximum allowed length (${spec.maxlength}).`);
      if (spec.match && !spec.match.test(text)) throw validationError(model, path, `Path \`${path}\` is invalid (${text}).`);
      return text;
    }
    case "boolean":
      return castBoolean(model, path, value);
    case "date": {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) throw castError(model, path, "date", value);
      return date;
    }
    case "numberArray":
    case "stringArray": {
      const list = (Array.isArray(value) ? value : [value]).map((item, index) => {
        if (spec.type === "stringArray") return String(item);
        const number = Number(item);
        if (item === null || item === "" || !Number.isFinite(number)) throw castError(model, `${path}.${index}`, "[Number]", item);
        return number;
      });
      if (spec.validate && !spec.validate(list)) throw validationError(model, path, spec.validateMessage);
      return list;
    }
    case "subdocs": {
      const list = Array.isArray(value) ? value : [value];
      return list.map((item, index) => {
        if (!item || typeof item !== "object") throw castError(model, `${path}.${index}`, "Embedded", item);
        // Mongoose gave every array subdocument its own _id.
        const subId = item._id != null && isValidId(String(item._id)) ? String(item._id) : newId();
        return { _id: subId, ...castFields(model, spec.of, item, { partial: false, prefix: `${path}.${index}.`, strict: true }) };
      });
    }
    default:
      return value;
  }
}

/**
 * Cast + validate like a Mongoose document (partial = update validators: only
 * the supplied paths are checked). Unknown keys pass through unless strict.
 */
function castFields(model, specs, data, { partial = false, prefix = "", strict = false } = {}) {
  const out = {};
  if (!strict) {
    Object.keys(data).forEach((key) => {
      if (!(key in specs) && data[key] !== undefined) out[key] = data[key];
    });
  }
  for (const [key, spec] of Object.entries(specs)) {
    const value = data[key];
    if (value === undefined) {
      if (partial) continue;
      if (spec.required) throw validationError(model, `${prefix}${key}`, `Path \`${prefix}${key}\` is required.`);
      if (spec.default) out[key] = spec.default();
      continue;
    }
    out[key] = castValue(model, `${prefix}${key}`, spec, value);
  }
  return out;
}

const validateDoc = (model, data, options) => castFields(model, SCHEMAS[model], data, options);

// Invalid ids used to raise a Mongoose CastError (400) before reaching the DB.
const requireId = (model, id) => {
  if (!isValidId(String(id ?? ""))) throw castError(model, "_id", "ObjectId", id);
  return String(id);
};

const DEFAULT_TARGET_NOTIFICATIONS = { calories: false, protein: false, weight: false };
const shapeProfile = (profile) => profile && {
  ...profile,
  targetNotifications: { ...DEFAULT_TARGET_NOTIFICATIONS, ...jsonObject(profile.targetNotifications) },
  dietaryPreferences: jsonArray(profile.dietaryPreferences),
  allergies: jsonArray(profile.allergies),
};
const shapeReminder = (reminder) => reminder && {
  ...reminder,
  days: Array.isArray(reminder.days) ? reminder.days : [0, 1, 2, 3, 4, 5, 6],
};
const shapeMeal = (meal) => meal && { ...meal, foods: jsonArray(meal.foods) };
const shapeWorkout = (workout) => workout && { ...workout, exercises: jsonArray(workout.exercises) };
const findProfile = async (user) => shapeProfile(await prisma.fitnessProfile.findUnique({ where: { user: String(user) } }));
const latestWeightLog = (user) => prisma.weightLog.findFirst({ where: { user: String(user) }, orderBy: { date: "desc" } });
const dayRange = (date) => ({ gte: startOfDay(date), lt: endOfDay(date) });

const buildAutoReminders = (profile) => {
  const calories = Math.round(Number(profile.targetCalories) || 0);
  const goalText = profile.goal === "lose"
    ? "support your weight-loss goal"
    : profile.goal === "gain"
      ? "support your weight-gain goal"
      : "support your maintenance goal";
  const movementTitle = ["very_active", "extra_active"].includes(profile.activityLevel)
    ? "Plan your workout"
    : "Take a movement break";
  return [
    {
      autoKey: "breakfast",
      title: "Breakfast reminder",
      type: "meal",
      time: "08:00",
      timezone: profile.timezone,
      message: `Log a balanced breakfast to ${goalText}${calories ? ` within your ${calories} kcal daily target` : ""}.`,
    },
    {
      autoKey: "lunch",
      title: "Lunch reminder",
      type: "meal",
      time: "13:00",
      timezone: profile.timezone,
      message: `Choose a protein- and vegetable-rich lunch to ${goalText}.`,
    },
    {
      autoKey: "dinner",
      title: "Dinner reminder",
      type: "meal",
      time: "20:00",
      timezone: profile.timezone,
      message: "Log dinner and keep the portion aligned with your remaining daily targets.",
    },
    {
      autoKey: "water-morning",
      title: "Drink water",
      type: "water",
      time: "10:00",
      timezone: profile.timezone,
      message: "Drink water and check in with your energy before your next meal.",
    },
    {
      autoKey: "water-afternoon",
      title: "Drink water",
      type: "water",
      time: "15:00",
      timezone: profile.timezone,
      message: "Drink water to stay hydrated through the afternoon.",
    },
    {
      autoKey: "movement",
      title: movementTitle,
      type: "workout",
      time: "18:00",
      timezone: profile.timezone,
      message: profile.activityLevel === "sedentary"
        ? "Try a short, comfortable walk or stretch. Adjust for your health needs."
        : "Keep your planned activity consistent with your fitness goal.",
    },
  ];
};

const ensureAutoReminders = async (userId, profile) => {
  const reminders = buildAutoReminders(profile);
  await Promise.all(reminders.map((reminder) => {
    const data = { ...validateDoc("Reminder", reminder, { partial: true }), autoGenerated: true, enabled: true };
    return prisma.reminder.upsert({
      where: { user_autoKey: { user: String(userId), autoKey: reminder.autoKey } },
      update: data,
      create: { ...validateDoc("Reminder", reminder), ...data, user: String(userId) },
    });
  }));
};

const getDailyBurn = async (userId, date) => {
  const totals = await prisma.workoutLog.aggregate({
    where: { user: String(userId), date: dayRange(date) },
    _sum: { caloriesBurned: true, durationMin: true },
    _count: { _all: true },
  });
  if (!totals._count._all) return { caloriesBurned: 0, durationMin: 0, workouts: 0 };
  return { _id: null, caloriesBurned: totals._sum.caloriesBurned || 0, durationMin: totals._sum.durationMin || 0, workouts: totals._count._all };
};

const derivedProfileFields = (profile) => {
  const nutrition = calculateNutrition(profile);
  const health = calculateHealthTargets(profile);
  return {
    bmr: nutrition.bmr,
    tdee: nutrition.tdee,
    targetCalories: nutrition.targetCalories,
    macros: nutrition.macros,
    bmi: health.bmi,
    waterTargetMl: health.waterTargetMl,
    stepTarget: health.stepTarget,
    weeklyWorkoutTarget: health.weeklyWorkoutTarget,
    sleepTargetHours: health.sleepTargetHours,
  };
};

// Older profiles were saved before habit targets existed.
const withTargets = (profile) => {
  if (!profile) return profile;
  const health = calculateHealthTargets(profile);
  return {
    ...profile,
    bmi: profile.bmi ?? health.bmi,
    bmiCategory: health.bmiCategory,
    healthyWeightRangeKg: health.healthyWeightRangeKg,
    waterTargetMl: profile.waterTargetMl || health.waterTargetMl,
    stepTarget: profile.stepTarget || health.stepTarget,
    weeklyWorkoutTarget: profile.weeklyWorkoutTarget || health.weeklyWorkoutTarget,
    sleepTargetHours: profile.sleepTargetHours || health.sleepTargetHours,
    pace: profile.pace || "standard",
  };
};

const getDailyTotals = async (userId, date) => {
  const totals = await prisma.meal.aggregate({
    where: { user: String(userId), date: dayRange(date) },
    _sum: { calories: true, proteinG: true, carbsG: true, fatG: true, fiberG: true },
    _count: { _all: true },
  });
  if (!totals._count._all) return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 };
  const sum = totals._sum;
  return { _id: null, calories: sum.calories || 0, proteinG: sum.proteinG || 0, carbsG: sum.carbsG || 0, fatG: sum.fatG || 0, fiberG: sum.fiberG || 0 };
};

const notifyHealthTargets = async (userId, date, totals) => {
  const profile = await findProfile(userId);
  if (!profile) return;

  const dayKey = startOfDay(date).toISOString().slice(0, 10);
  const previous = profile.targetNotifications?.date === dayKey
    ? profile.targetNotifications
    : { date: dayKey, calories: false, protein: false, weight: false };
  const notifications = [];
  if (!previous.calories && profile.targetCalories > 0 && totals.calories >= profile.targetCalories) {
    notifications.push({
      key: "calories",
      title: "Daily calorie target reached",
      body: `You reached your ${Math.round(profile.targetCalories)} kcal target today. Keep your next choices balanced.`,
    });
  }
  if (!previous.protein && profile.macros?.proteinG > 0 && totals.proteinG >= profile.macros.proteinG) {
    notifications.push({
      key: "protein",
      title: "Protein target reached",
      body: `You reached your ${Math.round(profile.macros.proteinG)} g protein target today. Great work.`,
    });
  }
  if (!notifications.length) return;

  const claimed = { ...previous };
  notifications.forEach(({ key }) => { claimed[key] = true; });
  await prisma.fitnessProfile.update({ where: { id: profile.id }, data: { targetNotifications: claimed } });
  for (const notification of notifications) {
    try {
      await sendPushToProfile(userId, {
        title: notification.title,
        body: notification.body,
        data: { type: "fitness_target", target: notification.key, date: dayKey },
      });
    } catch (error) {
      console.error("[fitness-target] push failed:", error?.message || error);
    }
  }
};

const notifyWeightTarget = async (userId, weightKg) => {
  const profile = await findProfile(userId);
  if (!profile?.targetWeightKg || profile.targetNotifications?.weight) return;
  const reached = profile.goal === "gain"
    ? weightKg >= profile.targetWeightKg
    : profile.goal === "lose"
      ? weightKg <= profile.targetWeightKg
      : false;
  if (!reached) return;
  await prisma.fitnessProfile.update({
    where: { id: profile.id },
    data: { targetNotifications: { ...profile.targetNotifications, weight: true } },
  });
  try {
    await sendPushToProfile(userId, {
      title: "Weight target reached",
      body: `You reached your ${profile.targetWeightKg} kg goal. Celebrate your progress and maintain healthy habits.`,
      data: { type: "fitness_target", target: "weight" },
    });
  } catch (error) {
    console.error("[fitness-target] weight push failed:", error?.message || error);
  }
};

const notifyAiFitnessUpdate = async (userId, title, body, target) => {
  try {
    await sendPushToProfile(userId, {
      title,
      body,
      data: { type: "fitness_ai_update", target },
    });
  } catch (error) {
    console.error("[fitness-ai] push failed:", error?.message || error);
  }
};

const getProfile = async (req, res) => {
  try {
    const profile = await findProfile(owner(req));
    return res.json({ success: true, profile: withTargets(profile) });
  } catch (error) { return handleError(res, error); }
};

const saveProfile = async (req, res) => {
  try {
    const payload = { ...pick(req.body, PROFILE_FIELDS), onboardingCompleted: req.body.onboardingCompleted !== false };
    if (payload.timezone !== undefined && !isValidTimezone(payload.timezone)) {
      return badRequest(res, "Invalid timezone");
    }
    if (payload.targetWeightKg === "" || payload.targetWeightKg === null) delete payload.targetWeightKg;
    ["age", "heightCm", "weightKg", "targetWeightKg"].forEach((key) => {
      if (payload[key] !== undefined) payload[key] = Number(payload[key]);
    });
    let derived;
    try {
      derived = derivedProfileFields(payload);
    } catch (error) {
      return badRequest(res, error.message);
    }
    const existing = await prisma.fitnessProfile.findUnique({ where: { user: owner(req) } });
    // Goal progress is measured from the weight at which the current goal was set.
    const goalChanged = !existing?.startWeightKg || existing.goal !== payload.goal || (existing.targetWeightKg ?? undefined) !== payload.targetWeightKg;
    const startWeightKg = goalChanged ? payload.weightKg : existing.startWeightKg;
    const fields = validateDoc("FitnessProfile", { ...payload, startWeightKg }, { partial: Boolean(existing) });
    const data = { ...fields, ...derived, targetWeightKg: fields.targetWeightKg ?? null };
    const profile = shapeProfile(await prisma.fitnessProfile.upsert({
      where: { user: owner(req) },
      update: data,
      create: { ...data, user: owner(req), targetNotifications: { ...DEFAULT_TARGET_NOTIFICATIONS } },
    }));
    try {
      await ensureAutoReminders(owner(req), profile);
    } catch (error) {
      console.error("[fitness-reminder] automatic reminder setup failed:", error?.message || error);
    }
    return res.json({ success: true, profile: withTargets(profile) });
  } catch (error) { return handleError(res, error); }
};

const resetFitness = async (req, res) => {
  try {
    const user = owner(req);
    await Promise.all([
      prisma.fitnessProfile.deleteMany({ where: { user } }),
      prisma.meal.deleteMany({ where: { user } }),
      prisma.weightLog.deleteMany({ where: { user } }),
      prisma.reminder.deleteMany({ where: { user } }),
      prisma.workoutLog.deleteMany({ where: { user } }),
      prisma.fitnessDailyLog.deleteMany({ where: { user } }),
    ]);
    return res.json({ success: true, message: "Fitness details were reset" });
  } catch (error) { return handleError(res, error); }
};

const dashboard = async (req, res) => {
  try {
    const user = owner(req);
    const date = req.query.date || new Date();
    const dayStart = startOfDay(date);
    const weekStart = new Date(dayStart.getTime() - 6 * 86400000);
    const streakStart = new Date(dayStart.getTime() - 120 * 86400000);
    const [rawProfile, meals, totals, burn, latestWeight, reminders, daily, workouts, weekMeals, weekWorkouts, mealDays, workoutDays, habitDays] = await Promise.all([
      findProfile(user),
      prisma.meal.findMany({ where: { user, date: { gte: dayStart, lt: endOfDay(date) } }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] }).then((rows) => rows.map(shapeMeal)),
      getDailyTotals(user, date),
      getDailyBurn(user, date),
      latestWeightLog(user),
      prisma.reminder.findMany({ where: { user, enabled: true }, orderBy: { time: "asc" } }).then((rows) => rows.map(shapeReminder)),
      prisma.fitnessDailyLog.findUnique({ where: { user_date: { user, date: dayStart } } }),
      prisma.workoutLog.findMany({ where: { user, date: { gte: dayStart, lt: endOfDay(date) } }, orderBy: { date: "desc" } }).then((rows) => rows.map(shapeWorkout)),
      prisma.meal.findMany({ where: { user, date: { gte: weekStart, lt: endOfDay(date) } }, select: { id: true, date: true, calories: true } }),
      prisma.workoutLog.findMany({ where: { user, date: { gte: weekStart, lt: endOfDay(date) } }, select: { id: true, date: true, durationMin: true, caloriesBurned: true } }),
      prisma.meal.findMany({ where: { user, date: { gte: streakStart } }, select: { date: true } }),
      prisma.workoutLog.findMany({ where: { user, date: { gte: streakStart } }, select: { date: true } }),
      prisma.fitnessDailyLog.findMany({ where: { user, date: { gte: streakStart }, OR: [{ waterMl: { gt: 0 } }, { steps: { gt: 0 } }] }, select: { date: true } }),
    ]);
    const profile = withTargets(rawProfile);
    if (!profile) return res.json({ success: true, date: dayStart, profile: null });

    const week = Array.from({ length: 7 }, (_, index) => {
      const key = dayKey(new Date(weekStart.getTime() + index * 86400000));
      return { date: key, calories: 0, caloriesBurned: 0, activeMinutes: 0, workouts: 0 };
    });
    const weekByKey = Object.fromEntries(week.map((item) => [item.date, item]));
    weekMeals.forEach((meal) => { const bucket = weekByKey[dayKey(meal.date)]; if (bucket) bucket.calories += meal.calories || 0; });
    weekWorkouts.forEach((workout) => {
      const bucket = weekByKey[dayKey(workout.date)];
      if (!bucket) return;
      bucket.caloriesBurned += workout.caloriesBurned || 0;
      bucket.activeMinutes += workout.durationMin || 0;
      bucket.workouts += 1;
    });
    week.forEach((item) => { item.calories = Math.round(item.calories); });

    const todayKey = dayKey(date);
    const streak = calculateStreak([...mealDays, ...workoutDays, ...habitDays].map((item) => dayKey(item.date)), todayKey);
    const currentWeightKg = latestWeight?.weightKg || profile.weightKg;
    const goalProgress = projectGoal({
      startWeightKg: profile.startWeightKg || profile.weightKg,
      currentWeightKg,
      targetWeightKg: profile.targetWeightKg,
      goal: profile.goal,
      pace: profile.pace,
    });
    const habits = { waterMl: daily?.waterMl || 0, steps: daily?.steps || 0, sleepHours: daily?.sleepHours || 0, mood: daily?.mood || null };
    const score = calculateDailyScore({
      calories: totals.calories,
      targetCalories: profile.targetCalories,
      proteinG: totals.proteinG,
      proteinTarget: profile.macros?.proteinG,
      waterMl: habits.waterMl,
      waterTarget: profile.waterTargetMl,
      steps: habits.steps,
      stepTarget: profile.stepTarget,
      activeMinutes: burn.durationMin,
      sleepHours: habits.sleepHours,
      sleepTarget: profile.sleepTargetHours,
    });
    return res.json({
      success: true,
      date: dayStart,
      profile,
      meals,
      mealCount: meals.length,
      totals,
      burn,
      habits,
      workouts,
      week,
      weekSummary: {
        workouts: week.reduce((sum, item) => sum + item.workouts, 0),
        activeMinutes: week.reduce((sum, item) => sum + item.activeMinutes, 0),
        workoutTarget: profile.weeklyWorkoutTarget,
      },
      streak,
      currentWeightKg,
      goalProgress,
      score,
      latestWeight,
      reminders,
    });
  } catch (error) { return handleError(res, error); }
};

const listMeals = async (req, res) => {
  try {
    const date = req.query.date || new Date();
    const meals = (await prisma.meal.findMany({ where: { user: owner(req), date: dayRange(date) }, orderBy: { createdAt: "desc" } })).map(shapeMeal);
    return res.json({ success: true, meals, totals: await getDailyTotals(owner(req), date) });
  } catch (error) { return handleError(res, error); }
};

// Distinct meals from the last 30 days so users can re-log favourites in one tap.
const recentMeals = async (req, res) => {
  try {
    const rows = await prisma.meal.findMany({
      where: { user: owner(req), date: { gte: new Date(Date.now() - 30 * 86400000) } },
      orderBy: { date: "desc" },
      select: { name: true, mealType: true, calories: true, proteinG: true, carbsG: true, fatG: true, fiberG: true, date: true },
    });
    // Group by lower-cased name, keeping the most recent entry's values.
    const groups = new Map();
    for (const row of rows) {
      const key = String(row.name).toLowerCase();
      const group = groups.get(key);
      if (group) { group.count += 1; continue; }
      const { date, ...values } = row;
      groups.set(key, { ...values, count: 1, lastLogged: date });
    }
    const meals = [...groups.values()]
      .sort((a, b) => b.count - a.count || b.lastLogged - a.lastLogged)
      .slice(0, 10);
    return res.json({ success: true, meals });
  } catch (error) { return handleError(res, error); }
};

const createMeal = async (req, res) => {
  try {
    const { date, mealType, name, servings, calories, proteinG, carbsG, fatG, fiberG, notes, source, imageUrl, analysis, foods } = req.body;
    if (!name || !String(name).trim()) return badRequest(res, "Meal name is required");
    const mealDate = new Date(date || Date.now());
    if (Number.isNaN(mealDate.getTime())) return badRequest(res, "A valid meal date is required");
    const data = validateDoc("Meal", { date: mealDate, mealType, name, servings, calories, proteinG, carbsG, fatG, fiberG, notes, source, imageUrl, analysis, foods, userConfirmedAt: new Date() });
    const meal = shapeMeal(await prisma.meal.create({ data: { ...data, user: owner(req) } }));
    const totals = await getDailyTotals(owner(req), meal.date);
    try {
      await notifyHealthTargets(owner(req), meal.date, totals);
    } catch (error) {
      console.error("[fitness-target] meal milestone check failed:", error?.message || error);
    }
    return res.status(201).json({ success: true, meal, totals });
  } catch (error) { return handleError(res, error); }
};

const getMeal = async (req, res) => {
  try {
    const meal = shapeMeal(await prisma.meal.findFirst({ where: { id: requireId("Meal", req.params.id), user: owner(req) } }));
    if (!meal) return res.status(404).json({ success: false, message: "Meal not found" });
    return res.json({ success: true, meal });
  } catch (error) {
    return handleError(res, error);
  }
};

const updateMeal = async (req, res) => {
  try {
    const update = pick(req.body, ["date", "mealType", "name", "servings", "calories", "proteinG", "carbsG", "fatG", "fiberG", "notes", "source", "imageUrl", "analysis", "foods"]);
    update.userConfirmedAt = new Date();
    if (update.date) {
      update.date = new Date(update.date);
      if (Number.isNaN(update.date.getTime())) return badRequest(res, "A valid meal date is required");
    }
    const id = requireId("Meal", req.params.id);
    const data = validateDoc("Meal", update, { partial: true });
    const { count } = await prisma.meal.updateMany({ where: { id, user: owner(req) }, data });
    if (!count) return res.status(404).json({ success: false, message: "Meal not found" });
    const meal = shapeMeal(await prisma.meal.findUnique({ where: { id } }));
    return res.json({ success: true, meal });
  } catch (error) { return handleError(res, error); }
};

const deleteMeal = async (req, res) => {
  try {
    const meal = await prisma.meal.findFirst({ where: { id: requireId("Meal", req.params.id), user: owner(req) } });
    if (!meal) return res.status(404).json({ success: false, message: "Meal not found" });
    await prisma.meal.delete({ where: { id: meal.id } });
    return res.json({ success: true, totals: await getDailyTotals(owner(req), meal.date) });
  } catch (error) { return handleError(res, error); }
};

const analyzeMeal = async (req, res) => {
  const name = String(req.body?.name || req.body?.description || "").trim();
  const mealType = ["breakfast", "lunch", "dinner", "snack"].includes(req.body?.mealType) ? req.body.mealType : "snack";
  if (name.length > 500) return badRequest(res, "A food description up to 500 characters is required");
  if (!name && !req.file) return badRequest(res, "Add a food name or photo to analyze");
  try {
    const enabled = await isProviderEnabled("gemini");
    const settings = await loadAiSettings();
    const key = await getProviderKey("gemini");
    if (!enabled || !key) {
      return res.json({ success: true, provider: "placeholder", requiresConfirmation: true, analysis: { name: name || "Analyzed meal", serving: "1 serving", calories: null, proteinG: null, carbsG: null, fatG: null, fiberG: null } });
    }
    const prompt = `Analyze this ${mealType} food image${name ? ` or description: ${name}` : ""} for one serving. Identify the food name from the image when possible. Return ONLY JSON with name, serving, calories, proteinG, carbsG, fatG, fiberG. Use conservative numeric estimates; never use null.`;
    const model = settings.models?.gemini || "gemini-2.0-flash";
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            ...(req.file ? [{ inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString("base64") } }] : []),
          ],
        }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      },
      { timeout: 20000, validateStatus: () => true },
    );
    if (response.status >= 400) return res.status(502).json({ success: false, message: "Food analysis is temporarily unavailable" });
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "{}";
    let analysis;
    try {
      analysis = normalizeNutrition(JSON.parse(text.replace(/^```json\s*|\s*```$/gi, "").trim()), name || "Analyzed meal");
    } catch (error) {
      return res.status(502).json({ success: false, message: "Food analysis returned invalid nutrition data" });
    }
    await notifyAiFitnessUpdate(
      owner(req),
      "Food analysis ready",
      "Your AI nutrition estimate is ready to review and save.",
      "food_analysis",
    );
    return res.json({ success: true, provider: "gemini", requiresConfirmation: true, analysis });
  } catch (error) {
    if (isProviderTimeout(error)) {
      console.warn("Gemini food analysis timed out");
      return res.status(504).json({ success: false, message: "Food analysis timed out. You can add this meal manually." });
    }
    console.error("Gemini food analysis failed:", error?.code || error?.message || "unknown provider error");
    return res.status(502).json({ success: false, message: "Food analysis is temporarily unavailable. You can add this meal manually." });
  }
};

const listWeights = async (req, res) => {
  try { return res.json({ success: true, weights: await prisma.weightLog.findMany({ where: { user: owner(req) }, orderBy: { date: "desc" }, take: 365 }) }); }
  catch (error) { return handleError(res, error); }
};
const addWeight = async (req, res) => {
  try {
    const logDate = startOfDay(req.body.date || new Date());
    const fields = pick(req.body, ["weightKg", "bodyFatPercent", "note"]);
    const existingWeight = await prisma.weightLog.findUnique({ where: { user_date: { user: owner(req), date: logDate } } });
    const data = validateDoc("WeightLog", { ...fields, date: logDate }, { partial: Boolean(existingWeight) });
    const weight = await prisma.weightLog.upsert({
      where: { user_date: { user: owner(req), date: logDate } },
      update: data,
      create: { ...data, user: owner(req) },
    });
    try {
      // Keep calorie and hydration targets in step with the newest weigh-in.
      const [profile, latest] = await Promise.all([
        findProfile(owner(req)),
        latestWeightLog(owner(req)),
      ]);
      if (profile && String(latest?.id) === String(weight.id)) {
        await prisma.fitnessProfile.update({ where: { id: profile.id }, data: { weightKg: weight.weightKg, ...derivedProfileFields({ ...profile, weightKg: weight.weightKg }) } });
      }
    } catch (error) {
      console.error("[fitness] target refresh after weigh-in failed:", error?.message || error);
    }
    try {
      await notifyWeightTarget(owner(req), weight.weightKg);
    } catch (error) {
      console.error("[fitness-target] weight milestone check failed:", error?.message || error);
    }
    return res.status(201).json({ success: true, weight });
  } catch (error) { return handleError(res, error); }
};
const deleteWeight = async (req, res) => {
  try {
    const { count } = await prisma.weightLog.deleteMany({ where: { id: requireId("WeightLog", req.params.id), user: owner(req) } });
    if (!count) return res.status(404).json({ success: false, message: "Weight entry not found" });
    return res.json({ success: true });
  } catch (error) { return handleError(res, error); }
};

const getDaily = async (req, res) => {
  try {
    const date = startOfDay(req.query.date || new Date());
    const daily = await prisma.fitnessDailyLog.findUnique({ where: { user_date: { user: owner(req), date } } });
    return res.json({ success: true, daily: daily || { date, waterMl: 0, steps: 0, sleepHours: 0 } });
  } catch (error) { return handleError(res, error); }
};

/**
 * Upsert a day's habits. `addWaterMl` increments (negative undoes a glass);
 * `waterMl`, `steps`, `sleepHours` and `mood` set absolute values.
 */
const updateDaily = async (req, res) => {
  try {
    const date = startOfDay(req.body.date || new Date());
    const set = pick(req.body, ["waterMl", "steps", "sleepHours", "mood"]);
    for (const [key, value] of Object.entries(set)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return badRequest(res, `${key} must be a positive number`);
      set[key] = number;
    }
    const addWaterMl = Number(req.body.addWaterMl) || 0;
    if (Math.abs(addWaterMl) > 3000) return badRequest(res, "addWaterMl is too large");
    const data = validateDoc("FitnessDailyLog", { ...set, date }, { partial: true });
    let daily = await prisma.fitnessDailyLog.upsert({
      where: { user_date: { user: owner(req), date } },
      update: data,
      create: { ...data, user: owner(req), date },
    });
    if (addWaterMl) {
      daily = await prisma.fitnessDailyLog.update({
        where: { id: daily.id },
        data: { waterMl: Math.min(10000, Math.max(0, (daily.waterMl || 0) + addWaterMl)) },
      });
    }
    return res.json({ success: true, daily });
  } catch (error) { return handleError(res, error); }
};

const WORKOUT_FIELDS = ["date", "name", "type", "intensity", "durationMin", "caloriesBurned", "exercises", "notes"];

const workoutPayload = async (req, body) => {
  const payload = pick(body, WORKOUT_FIELDS);
  if (payload.date !== undefined) {
    payload.date = new Date(payload.date);
    if (Number.isNaN(payload.date.getTime())) throw Object.assign(new Error("A valid workout date is required"), { name: "ValidationError" });
  }
  if (payload.caloriesBurned === undefined || payload.caloriesBurned === "" || payload.caloriesBurned === null) {
    const profile = await prisma.fitnessProfile.findUnique({ where: { user: owner(req) }, select: { weightKg: true } });
    payload.caloriesBurned = estimateWorkoutCalories({ ...payload, weightKg: profile?.weightKg });
  }
  return payload;
};

const listWorkouts = async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = startOfDay(new Date(Date.now() - (days - 1) * 86400000));
    const workouts = (await prisma.workoutLog.findMany({ where: { user: owner(req), date: { gte: since } }, orderBy: { date: "desc" }, take: 200 })).map(shapeWorkout);
    return res.json({ success: true, workouts });
  } catch (error) { return handleError(res, error); }
};

const createWorkout = async (req, res) => {
  try {
    const payload = await workoutPayload(req, { date: new Date(), ...req.body });
    if (!payload.name || !String(payload.name).trim()) return badRequest(res, "Workout name is required");
    const workout = shapeWorkout(await prisma.workoutLog.create({ data: { ...validateDoc("WorkoutLog", payload), user: owner(req) } }));
    return res.status(201).json({ success: true, workout, burn: await getDailyBurn(owner(req), workout.date) });
  } catch (error) { return handleError(res, error); }
};

const updateWorkout = async (req, res) => {
  try {
    const id = requireId("WorkoutLog", req.params.id);
    const payload = await workoutPayload(req, req.body);
    const { count } = await prisma.workoutLog.updateMany({ where: { id, user: owner(req) }, data: validateDoc("WorkoutLog", payload, { partial: true }) });
    if (!count) return res.status(404).json({ success: false, message: "Workout not found" });
    const workout = shapeWorkout(await prisma.workoutLog.findUnique({ where: { id } }));
    return res.json({ success: true, workout });
  } catch (error) { return handleError(res, error); }
};

const deleteWorkout = async (req, res) => {
  try {
    const { count } = await prisma.workoutLog.deleteMany({ where: { id: requireId("WorkoutLog", req.params.id), user: owner(req) } });
    if (!count) return res.status(404).json({ success: false, message: "Workout not found" });
    return res.json({ success: true });
  } catch (error) { return handleError(res, error); }
};

const progress = async (req, res) => {
  try {
    const period = ["daily", "weekly", "monthly", "quarterly"].includes(req.query.period)
      ? req.query.period
      : "monthly";
    const days = { daily: 1, weekly: 7, monthly: 30, quarterly: 90 }[period];
    const since = startOfDay(new Date(Date.now() - (days - 1) * 86400000));
    // Bucket by the server timezone (dayKey) so keys match startOfDay()-based habit and weight days.
    const bucketByDay = (rows, init, add) => {
      const buckets = new Map();
      rows.forEach((row) => {
        const key = dayKey(row.date);
        if (!buckets.has(key)) buckets.set(key, { _id: key, ...init() });
        add(buckets.get(key), row);
      });
      return [...buckets.values()].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    };
    const dayKeys = Array.from({ length: days }, (_, index) => dayKey(new Date(since.getTime() + index * 86400000 + 43200000)));
    const [rawProfile, workouts, habits, weights, meals] = await Promise.all([
      findProfile(owner(req)),
      prisma.workoutLog.findMany({ where: { user: owner(req), date: { gte: since } }, select: { date: true, durationMin: true, caloriesBurned: true } })
        .then((rows) => bucketByDay(rows, () => ({ durationMin: 0, caloriesBurned: 0, workouts: 0 }), (bucket, row) => {
          bucket.durationMin += row.durationMin || 0;
          bucket.caloriesBurned += row.caloriesBurned || 0;
          bucket.workouts += 1;
        })),
      prisma.fitnessDailyLog.findMany({ where: { user: owner(req), date: { gte: since } }, orderBy: { date: "asc" }, select: { _id: true, date: true, waterMl: true, steps: true, sleepHours: true } }),
      prisma.weightLog.findMany({ where: { user: owner(req), date: { gte: since } }, orderBy: { date: "asc" } }),
      prisma.meal.findMany({ where: { user: owner(req), date: { gte: since } }, select: { date: true, calories: true, proteinG: true, carbsG: true, fatG: true } })
        .then((rows) => bucketByDay(rows, () => ({ calories: 0, proteinG: 0, carbsG: 0, fatG: 0, meals: 0 }), (bucket, row) => {
          bucket.calories += row.calories || 0;
          bucket.proteinG += row.proteinG || 0;
          bucket.carbsG += row.carbsG || 0;
          bucket.fatG += row.fatG || 0;
          bucket.meals += 1;
        })),
    ]);
    const totalCalories = meals.reduce((sum, item) => sum + item.calories, 0);
    const profile = withTargets(rawProfile);
    const target = profile?.targetCalories || 0;
    const onTargetDays = target ? meals.filter((item) => Math.abs(item.calories - target) <= target * 0.1).length : 0;
    const average = (items, key) => {
      const values = items.map((item) => Number(item[key]) || 0).filter((value) => value > 0);
      return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : 0;
    };
    const firstWeight = weights[0]?.weightKg;
    const lastWeight = weights[weights.length - 1]?.weightKg;
    return res.json({
      success: true,
      period,
      days,
      since,
      dayKeys,
      targets: profile ? {
        calories: profile.targetCalories,
        proteinG: profile.macros?.proteinG,
        carbsG: profile.macros?.carbsG,
        fatG: profile.macros?.fatG,
        sleepHours: profile.sleepTargetHours,
        waterMl: profile.waterTargetMl,
        steps: profile.stepTarget,
        targetWeightKg: profile.targetWeightKg,
      } : null,
      weights: weights.map((entry) => ({ ...entry, day: dayKey(entry.date) })),
      nutrition: meals,
      workouts,
      habits: habits.map((entry) => ({ ...entry, day: dayKey(entry.date) })),
      summary: {
        onTargetDays,
        adherencePercent: meals.length ? Math.round((onTargetDays / meals.length) * 100) : 0,
        workoutCount: workouts.reduce((sum, item) => sum + item.workouts, 0),
        activeMinutes: workouts.reduce((sum, item) => sum + item.durationMin, 0),
        caloriesBurned: workouts.reduce((sum, item) => sum + item.caloriesBurned, 0),
        averageSteps: Math.round(average(habits, "steps")),
        averageWaterMl: Math.round(average(habits, "waterMl")),
        averageSleepHours: average(habits, "sleepHours"),
        weightChangeKg: firstWeight && lastWeight ? Math.round((lastWeight - firstWeight) * 10) / 10 : 0,
        loggedDays: meals.length,
        totalCalories,
        averageCalories: meals.length ? Math.round(totalCalories / meals.length) : 0,
        totalProteinG: meals.reduce((sum, item) => sum + item.proteinG, 0),
        totalCarbsG: meals.reduce((sum, item) => sum + item.carbsG, 0),
        totalFatG: meals.reduce((sum, item) => sum + item.fatG, 0),
      },
    });
  } catch (error) { return handleError(res, error); }
};

const todaysMealSummaries = (user) => prisma.meal.findMany({
  where: { user, date: dayRange(new Date()) },
  orderBy: { date: "desc" },
  select: { id: true, name: true, mealType: true, calories: true, proteinG: true, carbsG: true, fatG: true, fiberG: true, date: true },
});

const coach = async (req, res) => {
  const question = String(req.body?.question || "").trim();
  if (!question || question.length > 500) return badRequest(res, "A question up to 500 characters is required");
  try {
    const [rawProfile, totals, meals, burn, daily, latestWeight] = await Promise.all([
      findProfile(owner(req)),
      getDailyTotals(owner(req), new Date()),
      todaysMealSummaries(owner(req)),
      getDailyBurn(owner(req), new Date()),
      prisma.fitnessDailyLog.findUnique({ where: { user_date: { user: owner(req), date: startOfDay(new Date()) } } }),
      latestWeightLog(owner(req)),
    ]);
    if (!rawProfile) return badRequest(res, "Complete your fitness profile first");
    const profile = withTargets(rawProfile);
    // Short client-kept conversation so follow-up questions have context.
    const history = (Array.isArray(req.body?.history) ? req.body.history : [])
      .slice(-6)
      .filter((turn) => turn && typeof turn.text === "string" && ["user", "coach"].includes(turn.role))
      .map((turn) => ({ role: turn.role === "coach" ? "model" : "user", parts: [{ text: turn.text.slice(0, 1200) }] }));
    const key = await getProviderKey("gemini");
    if (!(await isProviderEnabled("gemini")) || !key) {
      return res.json({ success: true, reply: "Your fitness profile is ready. Add meals to get personalized guidance within your remaining calories." });
    }
    const settings = await loadAiSettings();
    const context = JSON.stringify({
      goal: profile.goal,
      pace: profile.pace,
      age: profile.age,
      sex: profile.sex,
      activityLevel: profile.activityLevel,
      currentWeightKg: latestWeight?.weightKg || profile.weightKg,
      targetWeightKg: profile.targetWeightKg,
      bmi: profile.bmi,
      targetCalories: profile.targetCalories,
      macros: profile.macros,
      dailyTargets: { waterMl: profile.waterTargetMl, steps: profile.stepTarget, sleepHours: profile.sleepTargetHours, weeklyWorkouts: profile.weeklyWorkoutTarget },
      today: totals,
      todayExercise: burn,
      todayHabits: { waterMl: daily?.waterMl || 0, steps: daily?.steps || 0, sleepHours: daily?.sleepHours || 0 },
      meals: meals.map((meal) => ({
        name: meal.name,
        mealType: meal.mealType,
        calories: meal.calories,
        proteinG: meal.proteinG,
        carbsG: meal.carbsG,
        fatG: meal.fatG,
        fiberG: meal.fiberG,
        date: meal.date,
      })),
    });
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.models?.gemini || "gemini-2.0-flash")}:generateContent?key=${encodeURIComponent(key)}`,
      {
        systemInstruction: { parts: [{ text: "You are a supportive, evidence-based health and fitness coach covering nutrition, training, hydration, sleep and habits. Use only the supplied numbers for the user's data. Give specific, actionable steps in short paragraphs or bullet points (under 180 words). Do not diagnose, prescribe medication, or recommend dangerous restriction or overtraining. Encourage a clinician for medical questions, pain, or injuries." }] },
        contents: [...history, { role: "user", parts: [{ text: `Context: ${context}\nQuestion: ${question}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
      },
      { timeout: 20000, validateStatus: () => true },
    );
    if (response.status >= 400) return res.status(502).json({ success: false, message: "Coach is temporarily unavailable" });
    const reply = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!reply) return res.status(502).json({ success: false, message: "Coach returned no guidance" });
    return res.json({ success: true, reply });
  } catch (error) {
    if (isProviderTimeout(error)) {
      console.warn("Gemini fitness coach timed out");
      return res.status(504).json({ success: false, message: "Coach timed out. Please try again shortly." });
    }
    console.error("Gemini fitness coach failed:", error?.code || error?.message || "unknown provider error");
    return res.status(502).json({ success: false, message: "Coach is temporarily unavailable. Please try again shortly." });
  }
};

const recommendations = async (req, res) => {
  try {
    const refreshToken = String(req.query.refresh || `${Date.now()}-${Math.random()}`);
    const themes = [
      "Try fresh seasonal ingredients and a cuisine you have not logged today.",
      "Prefer quick meals that can be prepared in under 20 minutes.",
      "Prefer budget-friendly common South Asian ingredients.",
      "Prefer high-protein meals with plenty of vegetables.",
      "Prefer light, refreshing meals suitable for a warm day.",
    ];
    const themeIndex = [...refreshToken].reduce((sum, character) => sum + character.charCodeAt(0), 0) % themes.length;
    const varietyInstruction = themes[themeIndex];
    const [profile, totals, meals] = await Promise.all([
      findProfile(owner(req)),
      getDailyTotals(owner(req), new Date()),
      todaysMealSummaries(owner(req)),
    ]);
    if (!profile) return badRequest(res, "Complete your fitness profile first");

    const remaining = {
      calories: Math.max(0, Math.round(profile.targetCalories - totals.calories)),
      proteinG: Math.max(0, Math.round(profile.macros.proteinG - totals.proteinG)),
      carbsG: Math.max(0, Math.round(profile.macros.carbsG - totals.carbsG)),
      fatG: Math.max(0, Math.round(profile.macros.fatG - totals.fatG)),
    };
    const fallbackSets = [
      [
        { name: "Dal, rice and vegetables", mealType: "lunch", calories: 520, proteinG: 20, carbsG: 82, fatG: 11, why: "Balanced local meal with fiber and plant protein." },
        { name: "Grilled fish with salad", mealType: "dinner", calories: 380, proteinG: 34, carbsG: 18, fatG: 18, why: "Protein-rich option with vegetables and healthy fats." },
        { name: "Egg and roti plate", mealType: "breakfast", calories: 410, proteinG: 21, carbsG: 48, fatG: 15, why: "Practical meal with protein and steady carbohydrates." },
      ],
      [
        { name: "Chicken chickpea salad bowl", mealType: "lunch", calories: 460, proteinG: 38, carbsG: 42, fatG: 14, why: "A varied, filling option with lean protein and fiber." },
        { name: "Vegetable omelette with toast", mealType: "breakfast", calories: 330, proteinG: 24, carbsG: 28, fatG: 15, why: "Quick protein-rich meal with vegetables." },
        { name: "Yogurt, fruit and nuts", mealType: "snack", calories: 290, proteinG: 18, carbsG: 32, fatG: 10, why: "Light snack with protein and satisfying healthy fats." },
      ],
      [
        { name: "Beef or tofu stir-fry", mealType: "dinner", calories: 490, proteinG: 32, carbsG: 40, fatG: 19, why: "Flexible protein-forward meal with colorful vegetables." },
        { name: "Tuna cucumber wrap", mealType: "lunch", calories: 370, proteinG: 29, carbsG: 36, fatG: 12, why: "Convenient balanced meal with fresh ingredients." },
        { name: "Banana peanut overnight oats", mealType: "breakfast", calories: 390, proteinG: 16, carbsG: 55, fatG: 13, why: "Fiber-rich breakfast for steady energy." },
      ],
    ];
    const fallback = {
      recommendations: fallbackSets[themeIndex % fallbackSets.length],
      healthNotes: ["Choose mostly whole foods and include vegetables or fruit with meals.", "Drink water regularly and adjust portions to your hunger and activity.", "These are general wellness suggestions, not medical advice."],
    };
    const key = await getProviderKey("gemini");
    if (!(await isProviderEnabled("gemini")) || !key) {
      return res.json({ success: true, source: "curated", totals, remaining, ...fallback });
    }
    const settings = await loadAiSettings();
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.models?.gemini || "gemini-2.0-flash")}:generateContent?key=${encodeURIComponent(key)}`,
      {
        systemInstruction: { parts: [{ text: "You are a safe nutrition coach. Never diagnose or prescribe. Use only supplied targets. Return JSON only. Recommend common South Asian foods when appropriate." }] },
        contents: [{ role: "user", parts: [{ text: `Create 3 genuinely different meal recommendations for this refresh request (${refreshToken}). Variety direction: ${varietyInstruction} Do not reuse these meals: ${JSON.stringify(meals.map((meal) => meal.name))}. Context: ${JSON.stringify({ goal: profile.goal, remaining, totals, meals: meals.map((meal) => ({ name: meal.name, mealType: meal.mealType, calories: meal.calories, proteinG: meal.proteinG, carbsG: meal.carbsG, fatG: meal.fatG, fiberG: meal.fiberG, date: meal.date })) })}. Each recommendation must be a realistic single serving, should not exceed the remaining calories by more than 10%, and should prioritize the remaining macro targets. Use different meal types and ingredients where possible. JSON shape: {"recommendations":[{"name":"string","mealType":"breakfast|lunch|dinner|snack","calories":number,"proteinG":number,"carbsG":number,"fatG":number,"why":"string"}],"healthNotes":["string"]}. Keep values plausible and include a disclaimer in healthNotes.` }] }],
        generationConfig: { temperature: 0.85, topP: 0.95, responseMimeType: "application/json", maxOutputTokens: 700 },
      },
      { timeout: 20000, validateStatus: () => true },
    );
    if (response.status >= 400) return res.json({ success: true, source: "curated", totals, remaining, ...fallback });
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || "";
    let result;
    try { result = JSON.parse(text.replace(/^```json\s*|\s*```$/gi, "").trim()); } catch (_) { result = null; }
    if (!result || !Array.isArray(result.recommendations) || result.recommendations.length === 0) {
      return res.json({ success: true, source: "curated", totals, remaining, ...fallback });
    }
    const safeRecommendations = result.recommendations.slice(0, 5).map((item) => ({
      name: String(item.name || "Suggested meal").slice(0, 120),
      calories: Math.max(0, Math.min(2000, Math.round(Number(item.calories) || 0))),
      proteinG: Math.max(0, Math.min(200, Math.round(Number(item.proteinG) || 0))),
      carbsG: Math.max(0, Math.min(300, Math.round(Number(item.carbsG) || 0))),
      fatG: Math.max(0, Math.min(150, Math.round(Number(item.fatG) || 0))),
      mealType: ["breakfast", "lunch", "dinner", "snack"].includes(item.mealType) ? item.mealType : "snack",
      why: String(item.why || "A balanced option within your remaining targets.").slice(0, 300),
    }));
    await notifyAiFitnessUpdate(
      owner(req),
      "Fitness recommendations ready",
      "Your personalized meal recommendations are ready to view.",
      "recommendations",
    );
    return res.json({ success: true, source: "gemini", totals, remaining, recommendations: safeRecommendations, healthNotes: Array.isArray(result.healthNotes) ? result.healthNotes.slice(0, 5).map((note) => String(note).slice(0, 300)) : fallback.healthNotes });
  } catch (error) {
    if (isProviderTimeout(error)) return res.status(504).json({ success: false, message: "Recommendations timed out. Please try again shortly." });
    console.error("Fitness recommendations failed:", error?.code || error?.message || "unknown provider error");
    return res.status(502).json({ success: false, message: "Recommendations are temporarily unavailable" });
  }
};

const listReminders = async (req, res) => {
  try { return res.json({ success: true, reminders: (await prisma.reminder.findMany({ where: { user: owner(req) }, orderBy: { time: "asc" } })).map(shapeReminder) }); }
  catch (error) { return handleError(res, error); }
};
const createReminder = async (req, res) => {
  try {
    if (req.body.timezone !== undefined && !isValidTimezone(req.body.timezone)) {
      return badRequest(res, "Invalid timezone");
    }
    const reminder = shapeReminder(await prisma.reminder.create({
      data: {
        ...validateDoc("Reminder", pick(req.body, ["title", "type", "time", "days", "enabled", "message", "notificationId", "timezone"])),
        user: owner(req),
        autoGenerated: false,
      },
    }));
    return res.status(201).json({ success: true, reminder });
  }
  catch (error) { return handleError(res, error); }
};
const updateReminder = async (req, res) => {
  try {
    const update = pick(req.body, ["title", "type", "time", "days", "enabled", "message", "notificationId", "timezone"]);
    if (update.timezone !== undefined && !isValidTimezone(update.timezone)) {
      return badRequest(res, "Invalid timezone");
    }
    const id = requireId("Reminder", req.params.id);
    const { count } = await prisma.reminder.updateMany({ where: { id, user: owner(req) }, data: validateDoc("Reminder", update, { partial: true }) });
    if (!count) return res.status(404).json({ success: false, message: "Reminder not found" });
    const reminder = shapeReminder(await prisma.reminder.findUnique({ where: { id } }));
    return res.json({ success: true, reminder });
  } catch (error) { return handleError(res, error); }
};
const deleteReminder = async (req, res) => {
  try {
    const { count } = await prisma.reminder.deleteMany({ where: { id: requireId("Reminder", req.params.id), user: owner(req) } });
    if (!count) return res.status(404).json({ success: false, message: "Reminder not found" });
    return res.json({ success: true });
  } catch (error) { return handleError(res, error); }
};

module.exports = {
  resetFitness, getProfile, saveProfile, dashboard, coach, recommendations,
  listMeals, recentMeals, createMeal, getMeal, updateMeal, deleteMeal, analyzeMeal,
  listWeights, addWeight, deleteWeight, progress,
  getDaily, updateDaily, listWorkouts, createWorkout, updateWorkout, deleteWorkout,
  listReminders, createReminder, updateReminder, deleteReminder,
  // Exposed for tests (replaces the Mongoose schema validators).
  validateDoc,
};
