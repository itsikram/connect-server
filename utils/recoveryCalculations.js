const {
  MILESTONES,
  SCREENERS,
  substanceMeta,
  safetyClassOf,
  timelineFor,
} = require("./recoveryContent");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_TIMEZONE = "Asia/Dhaka";

const round = (value, decimals = 0) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
};
const clamp01 = (value) => Math.min(Math.max(Number(value) || 0, 0), 1);
const average = (values) => {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value));
  return numbers.length ? round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length, 1) : null;
};

const isValidTimezone = (value) => {
  if (!value || typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch (_) {
    return false;
  }
};
const safeTimezone = (timezone) => (isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE);

const localParts = (date, timezone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(date));
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
};

/** Calendar day ("YYYY-MM-DD") of an instant in the user's timezone. */
const dayKey = (date, timezone) => {
  const parts = localParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const localHour = (date, timezone) => Number(localParts(date, timezone).hour) % 24;
const addDaysToKey = (key, days) => {
  const date = new Date(`${key}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** ISO-8601 week key ("2026-W39") of an instant in the user's timezone. */
const weekKey = (date, timezone) => {
  const day = new Date(`${dayKey(date, timezone)}T00:00:00.000Z`);
  // Move to the Thursday of this ISO week; its year owns the week.
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

const partOfDay = (hour) => {
  if (hour < 5) return "late night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
};

/** Average units used per day before quitting. */
const dailyUse = (substance) => {
  const amount = Math.max(0, Number(substance?.amountPerDay) || 0);
  const days = Math.min(7, Math.max(0, Number(substance?.daysPerWeek ?? 7)));
  return (amount * days) / 7;
};

const milestoneProgress = (streakMs) => {
  const days = Math.max(0, streakMs) / DAY_MS;
  const reached = MILESTONES.filter((milestone) => days >= milestone.days);
  const next = MILESTONES.find((milestone) => days < milestone.days) || null;
  const previousDays = reached.length ? reached[reached.length - 1].days : 0;
  return {
    reachedDays: previousDays,
    nextDays: next ? next.days : null,
    progress: next ? clamp01((days - previousDays) / (next.days - previousDays)) : 1,
    msToNext: next ? Math.max(0, next.days * DAY_MS - streakMs) : 0,
  };
};

/** Index of the last reached and the next step on the substance's health timeline. */
const healthProgress = (substanceKey, streakMs) => {
  const timeline = timelineFor(substanceKey);
  const hours = Math.max(0, streakMs) / HOUR_MS;
  let reachedIndex = -1;
  timeline.forEach((step, index) => {
    if (hours >= step.hours) reachedIndex = index;
  });
  const nextIndex = reachedIndex + 1 < timeline.length ? reachedIndex + 1 : null;
  return { reachedIndex, nextIndex, msToNext: nextIndex === null ? 0 : Math.max(0, timeline[nextIndex].hours * HOUR_MS - streakMs) };
};

/**
 * Clean-time statistics for one tracked substance.
 * - The current streak restarts after a slip.
 * - Longest streak and total clean days never go backwards.
 * `lapseDayKeys` are local day keys of logged slips for this substance.
 */
const substanceStats = (substance, { now = new Date(), lapseDayKeys = [], timezone } = {}) => {
  const meta = substanceMeta(substance.key);
  const nowMs = new Date(now).getTime();
  const quitMs = new Date(substance.quitDate).getTime();
  const streakStartMs = Math.max(new Date(substance.streakStart || substance.quitDate).getTime(), quitMs);
  const preparing = quitMs > nowMs;
  const currentStreakMs = preparing ? 0 : Math.max(0, nowMs - streakStartMs);
  const currentStreakDays = Math.floor(currentStreakMs / DAY_MS);
  const quitDayKey = dayKey(quitMs, timezone);
  const periodLapseDays = new Set(lapseDayKeys.filter((key) => key >= quitDayKey)).size;
  const periodCleanDays = preparing ? 0 : Math.max(0, (nowMs - quitMs) / DAY_MS - periodLapseDays);
  const cleanDaysFloat = Math.max(0, Number(substance.bankedCleanDays) || 0) + periodCleanDays;
  const unitsAvoided = dailyUse(substance) * cleanDaysFloat;
  return {
    key: substance.key,
    status: preparing ? "preparing" : "clean",
    msUntilQuit: preparing ? quitMs - nowMs : 0,
    currentStreakMs,
    currentStreakDays,
    longestStreakDays: Math.max(Number(substance.longestStreakDays) || 0, currentStreakDays),
    totalCleanDays: Math.floor(cleanDaysFloat),
    unitsAvoided: round(unitsAvoided, 1),
    moneySaved: Math.round(unitsAvoided * Math.max(0, Number(substance.costPerUnit) || 0)),
    lifeRegainedMinutes: meta.lifeMinutesPerUnit ? Math.round(unitsAvoided * meta.lifeMinutesPerUnit) : 0,
    milestone: milestoneProgress(currentStreakMs),
    health: healthProgress(substance.key, currentStreakMs),
  };
};

/**
 * Returns the substance fields to save after a slip. The current streak restarts at
 * the slip (or at a new quit date); longest streak and banked clean days are kept.
 */
const applyLapse = (substance, lapseAt, { restart = "continue", newQuitDate, now = new Date(), timezone, lapseDayKeys = [] } = {}) => {
  const lapseMs = Math.min(new Date(lapseAt).getTime(), new Date(now).getTime());
  const streakStartMs = new Date(substance.streakStart || substance.quitDate).getTime();
  const streakDays = Math.max(0, Math.floor((lapseMs - streakStartMs) / DAY_MS));
  const longestStreakDays = Math.max(Number(substance.longestStreakDays) || 0, streakDays);
  if (restart === "new_date" && newQuitDate) {
    // Bank the clean days earned so far before the quit date moves forward.
    const stats = substanceStats(substance, { now: lapseMs, lapseDayKeys, timezone });
    const quitDate = new Date(newQuitDate);
    return { longestStreakDays, bankedCleanDays: round(stats.totalCleanDays, 0), quitDate, streakStart: quitDate };
  }
  return {
    longestStreakDays,
    bankedCleanDays: Number(substance.bankedCleanDays) || 0,
    quitDate: new Date(substance.quitDate),
    streakStart: new Date(Math.max(lapseMs, streakStartMs)),
  };
};

const severityFor = (tool, score, substanceKey) => {
  if (tool === "SDS") {
    const cutoff = substanceMeta(substanceKey).sdsCutoff || 4;
    if (score >= SCREENERS.SDS.thresholds.high) return "high";
    return score >= cutoff ? "moderate" : "low";
  }
  const { moderate, high } = SCREENERS[tool].thresholds;
  if (score >= high) return "high";
  return score >= moderate ? "moderate" : "low";
};

/** Scores screener answers (option indexes). Returns null for missing or invalid answers. */
const scoreScreener = (tool, answers, substanceKey) => {
  const screener = SCREENERS[tool];
  if (!screener || !Array.isArray(answers) || answers.length !== screener.questions.length) return null;
  let score = 0;
  for (let index = 0; index < answers.length; index += 1) {
    const option = screener.questions[index].options[Number(answers[index])];
    if (!option || !Number.isInteger(Number(answers[index]))) return null;
    score += option.score;
  }
  return { tool, score, severity: severityFor(tool, score, substanceKey) };
};

const DEFAULT_TOOL_ORDER = ["urge_surf", "breathing", "reasons", "call_support", "distract", "tape_forward", "grounding", "four_ds", "coach"];

/** Per-tool use and success counts from logged SOS sessions. */
const toolStats = (cravings = []) => {
  const stats = {};
  for (const craving of cravings) {
    for (const tool of new Set(craving.tools || [])) {
      if (!DEFAULT_TOOL_ORDER.includes(tool)) continue;
      stats[tool] = stats[tool] || { used: 0, resisted: 0 };
      stats[tool].used += 1;
      if (craving.outcome === "resisted") stats[tool].resisted += 1;
    }
  }
  return stats;
};

/** SOS tools ordered by this person's success rate (Laplace-smoothed), default order on ties. */
const rankTools = (cravings = []) => {
  const stats = toolStats(cravings);
  const score = (tool) => (stats[tool] ? (stats[tool].resisted + 1) / (stats[tool].used + 2) : 0.5);
  return [...DEFAULT_TOOL_ORDER].sort((a, b) => score(b) - score(a) || DEFAULT_TOOL_ORDER.indexOf(a) - DEFAULT_TOOL_ORDER.indexOf(b));
};

/** Hours of the day (local) when cravings cluster; needs at least `min` events per hour. */
const riskHours = (cravings = [], timezone, { min = 3, top = 2 } = {}) => {
  const counts = new Array(24).fill(0);
  cravings.forEach((craving) => {
    counts[localHour(craving.at, timezone)] += 1;
  });
  return counts
    .map((count, hour) => ({ hour, count }))
    .filter((item) => item.count >= min)
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
    .slice(0, top)
    .map((item) => item.hour);
};

const stageOfChange = ({ importance = 0, substances = [], now = new Date() }) => {
  const nowMs = new Date(now).getTime();
  const quitTimes = substances.map((substance) => new Date(substance.quitDate).getTime()).filter(Number.isFinite);
  if (!quitTimes.length) return importance >= 4 ? "contemplation" : "precontemplation";
  const started = quitTimes.filter((time) => time <= nowMs);
  if (started.length) {
    const longestDays = Math.max(...started.map((time) => (nowMs - time) / DAY_MS));
    return longestDays >= 180 ? "maintenance" : "action";
  }
  const soonestDays = Math.min(...quitTimes.map((time) => (time - nowMs) / DAY_MS));
  if (importance >= 7 && soonestDays <= 30) return "preparation";
  return importance >= 4 ? "contemplation" : "precontemplation";
};

/** Reasons to show the "talk to a professional" card (empty = hide). */
const professionalHelpReasons = ({ substances = [], lastCrisisAt, lapsesLast30 = 0, now = new Date() }) => {
  const reasons = [];
  if (substances.some((substance) => substance.screener?.severity === "high")) reasons.push("severity");
  if (substances.some((substance) => ["opioid", "medical_taper"].includes(safetyClassOf(substance.key)))) reasons.push("medical");
  if (lastCrisisAt && new Date(now).getTime() - new Date(lastCrisisAt).getTime() < 7 * DAY_MS) reasons.push("crisis");
  if (lapsesLast30 >= 3) reasons.push("lapses");
  return reasons;
};

/** Consecutive days with a check-in, ending today (or yesterday if today is not done yet). */
const checkinStreak = (dayKeys = [], todayKey) => {
  const days = new Set(dayKeys);
  let key = days.has(todayKey) ? todayKey : addDaysToKey(todayKey, -1);
  let streak = 0;
  while (days.has(key)) {
    streak += 1;
    key = addDaysToKey(key, -1);
  }
  return streak;
};

/** Badge keys earned so far; badges are never taken away. */
const earnedBadgeKeys = ({ longestStreakDays = 0, cravingsResisted = 0, checkinCount = 0 }) => {
  const keys = [];
  MILESTONES.forEach((milestone) => {
    if (longestStreakDays >= milestone.days) keys.push(`clean_${milestone.days}`);
  });
  [1, 10, 50, 100].forEach((count) => {
    if (cravingsResisted >= count) keys.push(`cravings_${count}`);
  });
  [7, 30].forEach((count) => {
    if (checkinCount >= count) keys.push(`checkins_${count}`);
  });
  return keys;
};

/** Seven-day summary used as AI context and on the dashboard. */
const recentStats = ({ checkins = [], cravings = [] }) => ({
  checkins: checkins.length,
  avgMood: average(checkins.map((checkin) => checkin.mood)),
  avgCraving: average(checkins.map((checkin) => checkin.craving)),
  cravingsLogged: cravings.length,
  cravingsResisted: cravings.filter((craving) => craving.outcome === "resisted").length,
});

module.exports = {
  HOUR_MS,
  DAY_MS,
  DEFAULT_TIMEZONE,
  DEFAULT_TOOL_ORDER,
  isValidTimezone,
  safeTimezone,
  localParts,
  dayKey,
  localHour,
  addDaysToKey,
  weekKey,
  partOfDay,
  dailyUse,
  milestoneProgress,
  healthProgress,
  substanceStats,
  applyLapse,
  scoreScreener,
  severityFor,
  toolStats,
  rankTools,
  riskHours,
  stageOfChange,
  professionalHelpReasons,
  checkinStreak,
  earnedBadgeKeys,
  recentStats,
};
