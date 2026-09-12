const axios = require("axios");
const FitnessProfile = require("../models/FitnessProfile");
const Meal = require("../models/Meal");
const WeightLog = require("../models/WeightLog");
const Reminder = require("../models/Reminder");
const { calculateNutrition } = require("../utils/fitnessCalculations");
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
const owner = (req) => req.profile?._id;
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

const getDailyTotals = async (userId, date) => {
  const totals = await Meal.aggregate([
    { $match: { user: userId, date: { $gte: startOfDay(date), $lt: endOfDay(date) } } },
    { $group: { _id: null, calories: { $sum: "$calories" }, proteinG: { $sum: "$proteinG" }, carbsG: { $sum: "$carbsG" }, fatG: { $sum: "$fatG" }, fiberG: { $sum: "$fiberG" } } },
  ]);
  return totals[0] || { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 };
};

const notifyHealthTargets = async (userId, date, totals) => {
  const profile = await FitnessProfile.findOne({ user: userId });
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
  await FitnessProfile.updateOne({ _id: profile._id }, { $set: { targetNotifications: claimed } });
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
  const profile = await FitnessProfile.findOne({ user: userId });
  if (!profile?.targetWeightKg || profile.targetNotifications?.weight) return;
  const reached = profile.goal === "gain"
    ? weightKg >= profile.targetWeightKg
    : profile.goal === "lose"
      ? weightKg <= profile.targetWeightKg
      : false;
  if (!reached) return;
  await FitnessProfile.updateOne({ _id: profile._id }, { $set: { "targetNotifications.weight": true } });
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
    const profile = await FitnessProfile.findOne({ user: owner(req) }).lean();
    return res.json({ success: true, profile });
  } catch (error) { return handleError(res, error); }
};

const saveProfile = async (req, res) => {
  try {
    const payload = { ...req.body, onboardingCompleted: req.body.onboardingCompleted !== false };
    const nutrition = calculateNutrition(payload);
    const profile = await FitnessProfile.findOneAndUpdate(
      { user: owner(req) },
      { ...payload, user: owner(req), ...nutrition, macros: nutrition.macros },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    return res.json({ success: true, profile });
  } catch (error) { return handleError(res, error); }
};

const resetFitness = async (req, res) => {
  try {
    const user = owner(req);
    await Promise.all([
      FitnessProfile.deleteOne({ user }),
      Meal.deleteMany({ user }),
      WeightLog.deleteMany({ user }),
      Reminder.deleteMany({ user }),
    ]);
    return res.json({ success: true, message: "Fitness details were reset" });
  } catch (error) { return handleError(res, error); }
};

const dashboard = async (req, res) => {
  try {
    const date = req.query.date || new Date();
    const [profile, meals, totals, latestWeight, reminders] = await Promise.all([
      FitnessProfile.findOne({ user: owner(req) }).lean(),
      Meal.find({ user: owner(req), date: { $gte: startOfDay(date), $lt: endOfDay(date) } }).sort({ createdAt: -1 }).lean(),
      getDailyTotals(owner(req), date),
      WeightLog.findOne({ user: owner(req) }).sort({ date: -1 }).lean(),
      Reminder.find({ user: owner(req), enabled: true }).sort({ time: 1 }).lean(),
    ]);
    return res.json({ success: true, date: startOfDay(date), profile, meals, totals, latestWeight, reminders });
  } catch (error) { return handleError(res, error); }
};

const listMeals = async (req, res) => {
  try {
    const date = req.query.date || new Date();
    const meals = await Meal.find({ user: owner(req), date: { $gte: startOfDay(date), $lt: endOfDay(date) } }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, meals, totals: await getDailyTotals(owner(req), date) });
  } catch (error) { return handleError(res, error); }
};

const createMeal = async (req, res) => {
  try {
    const { date, mealType, name, servings, calories, proteinG, carbsG, fatG, fiberG, notes, source, imageUrl, analysis, foods } = req.body;
    if (!name || !String(name).trim()) return badRequest(res, "Meal name is required");
    const mealDate = new Date(date || Date.now());
    if (Number.isNaN(mealDate.getTime())) return badRequest(res, "A valid meal date is required");
    const meal = await Meal.create({ user: owner(req), date: mealDate, mealType, name, servings, calories, proteinG, carbsG, fatG, fiberG, notes, source, imageUrl, analysis, foods, userConfirmedAt: new Date() });
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
    const meal = await Meal.findOne({ _id: req.params.id, user: owner(req) }).lean();
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
    const meal = await Meal.findOneAndUpdate({ _id: req.params.id, user: owner(req) }, update, { new: true, runValidators: true });
    if (!meal) return res.status(404).json({ success: false, message: "Meal not found" });
    return res.json({ success: true, meal });
  } catch (error) { return handleError(res, error); }
};

const deleteMeal = async (req, res) => {
  try {
    const meal = await Meal.findOneAndDelete({ _id: req.params.id, user: owner(req) });
    if (!meal) return res.status(404).json({ success: false, message: "Meal not found" });
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
  try { return res.json({ success: true, weights: await WeightLog.find({ user: owner(req) }).sort({ date: -1 }).limit(365).lean() }); }
  catch (error) { return handleError(res, error); }
};
const addWeight = async (req, res) => {
  try {
    const weight = await WeightLog.findOneAndUpdate({ user: owner(req), date: startOfDay(req.body.date) }, { ...req.body, user: owner(req), date: startOfDay(req.body.date) }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
    try {
      await notifyWeightTarget(owner(req), weight.weightKg);
    } catch (error) {
      console.error("[fitness-target] weight milestone check failed:", error?.message || error);
    }
    return res.status(201).json({ success: true, weight });
  } catch (error) { return handleError(res, error); }
};
const progress = async (req, res) => {
  try {
    const period = ["daily", "weekly", "monthly"].includes(req.query.period)
      ? req.query.period
      : "monthly";
    const days = period === "daily" ? 1 : period === "weekly" ? 7 : 30;
    const since = startOfDay(new Date(Date.now() - (days - 1) * 86400000));
    const groupFormat = period === "monthly" ? "%Y-%m-%d" : "%Y-%m-%d";
    const [weights, meals] = await Promise.all([
      WeightLog.find({ user: owner(req), date: { $gte: since } }).sort({ date: 1 }).lean(),
      Meal.aggregate([
        { $match: { user: owner(req), date: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: groupFormat, date: "$date" } },
            calories: { $sum: "$calories" },
            proteinG: { $sum: "$proteinG" },
            carbsG: { $sum: "$carbsG" },
            fatG: { $sum: "$fatG" },
            meals: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);
    const totalCalories = meals.reduce((sum, item) => sum + item.calories, 0);
    return res.json({
      success: true,
      period,
      days,
      weights,
      nutrition: meals,
      summary: {
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

const coach = async (req, res) => {
  const question = String(req.body?.question || "").trim();
  if (!question || question.length > 500) return badRequest(res, "A question up to 500 characters is required");
  try {
    const [profile, totals, meals] = await Promise.all([
      FitnessProfile.findOne({ user: owner(req) }).lean(),
      getDailyTotals(owner(req), new Date()),
      Meal.find({ user: owner(req), date: { $gte: startOfDay(new Date()), $lt: endOfDay(new Date()) } })
        .sort({ date: -1 })
        .select("name mealType calories proteinG carbsG fatG fiberG date")
        .lean(),
    ]);
    if (!profile) return badRequest(res, "Complete your fitness profile first");
    const key = await getProviderKey("gemini");
    if (!(await isProviderEnabled("gemini")) || !key) {
      return res.json({ success: true, reply: "Your fitness profile is ready. Add meals to get personalized guidance within your remaining calories." });
    }
    const settings = await loadAiSettings();
    const context = JSON.stringify({
      goal: profile.goal,
      targetCalories: profile.targetCalories,
      macros: profile.macros,
      today: totals,
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
        systemInstruction: { parts: [{ text: "You are a safe nutrition coach. Use only the supplied numbers. Do not diagnose, prescribe medication, or recommend dangerous restriction. Encourage a clinician for medical questions." }] },
        contents: [{ role: "user", parts: [{ text: `Context: ${context}\nQuestion: ${question}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
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
    const [profile, totals, meals] = await Promise.all([
      FitnessProfile.findOne({ user: owner(req) }).lean(),
      getDailyTotals(owner(req), new Date()),
      Meal.find({ user: owner(req), date: { $gte: startOfDay(new Date()), $lt: endOfDay(new Date()) } })
        .sort({ date: -1 })
        .select("name mealType calories proteinG carbsG fatG fiberG date")
        .lean(),
    ]);
    if (!profile) return badRequest(res, "Complete your fitness profile first");

    const remaining = {
      calories: Math.max(0, Math.round(profile.targetCalories - totals.calories)),
      proteinG: Math.max(0, Math.round(profile.macros.proteinG - totals.proteinG)),
      carbsG: Math.max(0, Math.round(profile.macros.carbsG - totals.carbsG)),
      fatG: Math.max(0, Math.round(profile.macros.fatG - totals.fatG)),
    };
    const fallback = {
      recommendations: [
        { name: "Dal, rice and vegetables", mealType: "lunch", calories: 520, proteinG: 20, carbsG: 82, fatG: 11, why: "Balanced local meal with fiber and plant protein." },
        { name: "Grilled fish with salad", mealType: "dinner", calories: 380, proteinG: 34, carbsG: 18, fatG: 18, why: "Protein-rich option with vegetables and healthy fats." },
        { name: "Egg and roti plate", mealType: "breakfast", calories: 410, proteinG: 21, carbsG: 48, fatG: 15, why: "Practical meal with protein and steady carbohydrates." },
      ],
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
        contents: [{ role: "user", parts: [{ text: `Create 3 meal recommendations for this user. Context: ${JSON.stringify({ goal: profile.goal, remaining, totals, meals: meals.map((meal) => ({ name: meal.name, mealType: meal.mealType, calories: meal.calories, proteinG: meal.proteinG, carbsG: meal.carbsG, fatG: meal.fatG, fiberG: meal.fiberG, date: meal.date })) })}. Use the logged meal types to avoid repeating an already completed meal when possible. JSON shape: {"recommendations":[{"name":"string","mealType":"breakfast|lunch|dinner|snack","calories":number,"proteinG":number,"carbsG":number,"fatG":number,"why":"string"}],"healthNotes":["string"]}. Keep values plausible and include a disclaimer in healthNotes.` }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: 700 },
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
  try { return res.json({ success: true, reminders: await Reminder.find({ user: owner(req) }).sort({ time: 1 }).lean() }); }
  catch (error) { return handleError(res, error); }
};
const createReminder = async (req, res) => {
  try { return res.status(201).json({ success: true, reminder: await Reminder.create({ ...req.body, user: owner(req) }) }); }
  catch (error) { return handleError(res, error); }
};
const updateReminder = async (req, res) => {
  try {
    const update = pick(req.body, ["title", "type", "time", "days", "enabled", "message", "notificationId"]);
    const reminder = await Reminder.findOneAndUpdate({ _id: req.params.id, user: owner(req) }, update, { new: true, runValidators: true });
    if (!reminder) return res.status(404).json({ success: false, message: "Reminder not found" });
    return res.json({ success: true, reminder });
  } catch (error) { return handleError(res, error); }
};
const deleteReminder = async (req, res) => {
  try {
    const reminder = await Reminder.findOneAndDelete({ _id: req.params.id, user: owner(req) });
    if (!reminder) return res.status(404).json({ success: false, message: "Reminder not found" });
    return res.json({ success: true });
  } catch (error) { return handleError(res, error); }
};

module.exports = { resetFitness, getProfile, saveProfile, dashboard, coach, recommendations, listMeals, createMeal, getMeal, updateMeal, deleteMeal, analyzeMeal, listWeights, addWeight, progress, listReminders, createReminder, updateReminder, deleteReminder };
