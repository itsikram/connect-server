const RecoveryProfileModel = require("../models/RecoveryProfile");
const RecoveryCheckInModel = require("../models/RecoveryCheckIn");
const RecoveryCravingModel = require("../models/RecoveryCraving");
const RecoveryLapseModel = require("../models/RecoveryLapse");
const RecoveryChatMessageModel = require("../models/RecoveryChatMessage");
const defaultAi = require("../services/recoveryAi");
const {
  BADGES,
  CRISIS_MESSAGES,
  HALT,
  HALT_KEYS,
  HELPLINES,
  MILESTONES,
  POINTS,
  REASONS,
  REASON_KEYS,
  SAFETY_CLASSES,
  SCREENERS,
  SUBSTANCES,
  SUBSTANCE_KEYS,
  TIMELINES,
  TOOL_KEYS,
  TRIGGERS,
  TRIGGER_KEYS,
  localize,
  normalizeLang,
  safetyClassOf,
  substanceMeta,
  timelineFor,
} = require("../utils/recoveryContent");
const {
  DAY_MS,
  DEFAULT_TIMEZONE,
  addDaysToKey,
  applyLapse,
  checkinStreak,
  dayKey,
  earnedBadgeKeys,
  isValidTimezone,
  professionalHelpReasons,
  rankTools,
  recentStats,
  riskHours,
  safeTimezone,
  scoreScreener,
  stageOfChange,
  substanceStats,
} = require("../utils/recoveryCalculations");
const { detectCrisis, maxRisk } = require("../utils/recoveryCrisis");
const { decryptJson, decryptText, encryptJson, encryptText } = require("../utils/recoveryCrypto");

// Recovery data is sensitive: handlers never log request bodies, notes or AI text.
const AI_WINDOW_MS = 10 * 60 * 1000;
const AI_CALLS_PER_WINDOW = 40;
const SUMMARY_EVERY_MESSAGES = 12;
const CRISIS_HELPLINE_KEYS = ["emergency", "kaan_pete_roi", "shastho_batayon"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const owner = (req) => req.profile?._id;
const clip = (value, max) => String(value ?? "").trim().slice(0, max);
const toNumber = (value, min, max, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const toInt = (value, min, max, fallback) => {
  const number = toNumber(value, min, max, undefined);
  return number === undefined ? fallback : Math.round(number);
};
const pickKeys = (values, allowed, max) => [...new Set((Array.isArray(values) ? values : []).map(String).filter((value) => allowed.includes(value)))].slice(0, max);
const toDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const iso = (value) => (value ? new Date(value).toISOString() : null);
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
const plain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc);

const badRequest = (res, message) => res.status(400).json({ success: false, message });
const notSetUp = (res) => res.status(404).json({ success: false, code: "NOT_SET_UP", message: "Set up Recovery first" });
const handleError = (res, error) => {
  if (error?.name === "ValidationError" || error?.name === "CastError") return badRequest(res, error.message);
  console.error("Recovery request failed:", error?.name || "Error", error?.code || "");
  return res.status(500).json({ success: false, message: "Recovery request failed" });
};

const resolveLang = (req, profile) => {
  const requested = req.query?.lang || req.body?.lang;
  if (requested) return normalizeLang(requested);
  return profile?.language === "bn" || profile?.language === "en" ? profile.language : "en";
};

const crisisPayload = (risk, lang) =>
  risk?.level === "crisis"
    ? {
        type: risk.type,
        message: localize(CRISIS_MESSAGES[risk.type] || CRISIS_MESSAGES.general, lang),
        helplines: localize(HELPLINES.filter((line) => CRISIS_HELPLINE_KEYS.includes(line.key)), lang),
      }
    : null;

const badgeView = (badges, lang) =>
  badges
    .map((badge) => (typeof badge === "string" ? { key: badge } : badge))
    .filter((badge) => BADGES[badge.key])
    .map((badge) => ({ key: badge.key, icon: BADGES[badge.key].icon, label: localize(BADGES[badge.key].label, lang), at: iso(badge.at) }));

// ---------------------------------------------------------------------------
// Shaping data for the app (decrypts; never exposes *Enc fields)
// ---------------------------------------------------------------------------
const toClientProfile = (doc) => {
  if (!doc) return null;
  return {
    substances: (doc.substances || []).map((substance) => ({
      key: substance.key,
      customName: substance.customName || "",
      primary: Boolean(substance.primary),
      amountPerDay: substance.amountPerDay ?? 0,
      daysPerWeek: substance.daysPerWeek ?? 7,
      costPerUnit: substance.costPerUnit ?? 0,
      yearsUsing: substance.yearsUsing ?? null,
      wakeUse: substance.wakeUse || "",
      approach: substance.approach,
      quitDate: iso(substance.quitDate),
      streakStart: iso(substance.streakStart || substance.quitDate),
      longestStreakDays: substance.longestStreakDays || 0,
      bankedCleanDays: substance.bankedCleanDays || 0,
      screener: substance.screener?.tool ? { tool: substance.screener.tool, score: substance.screener.score ?? null, severity: substance.screener.severity || "" } : null,
    })),
    readiness: { importance: doc.readiness?.importance ?? 8, confidence: doc.readiness?.confidence ?? 5 },
    reasonKeys: doc.reasonKeys || [],
    reasons: decryptText(doc.reasonsEnc),
    letter: decryptText(doc.letterEnc),
    triggers: doc.triggers || [],
    riskHours: doc.riskHours || [],
    supportContacts: decryptJson(doc.supportContactsEnc, []),
    plan: decryptJson(doc.planEnc, null),
    planSource: doc.planSource || "",
    planGeneratedAt: iso(doc.planGeneratedAt),
    points: doc.points || 0,
    badges: (doc.badges || []).map((badge) => ({ key: badge.key, at: iso(badge.at) })),
    settings: { aiEnabled: doc.settings?.aiEnabled !== false, discreet: doc.settings?.discreet !== false, riskNudges: Boolean(doc.settings?.riskNudges) },
    language: doc.language || "auto",
    timezone: doc.timezone || DEFAULT_TIMEZONE,
    currency: doc.currency || "BDT",
    onboardingCompleted: Boolean(doc.onboardingCompleted),
  };
};

const toClientCheckin = (doc) => {
  const reflection = decryptJson(doc.reflectionEnc, null);
  return {
    day: doc.day,
    used: (doc.used || []).map((item) => ({ substance: item.substance, amount: item.amount })),
    mood: doc.mood,
    craving: doc.craving,
    stress: doc.stress ?? null,
    sleepHours: doc.sleepHours ?? null,
    halt: doc.halt || [],
    triggers: doc.triggers || [],
    note: decryptText(doc.noteEnc),
    reflection: reflection?.reflection || "",
    microGoal: reflection?.microGoal || "",
    risk: doc.risk || "none",
  };
};

const toClientCraving = (doc) => ({
  id: String(doc._id),
  clientId: doc.clientId,
  at: iso(doc.at),
  substance: doc.substance,
  intensityStart: doc.intensityStart,
  intensityEnd: doc.intensityEnd ?? null,
  trigger: doc.trigger || "",
  tools: doc.tools || [],
  durationSec: doc.durationSec || 0,
  outcome: doc.outcome,
});

const toClientLapse = (doc) => ({
  id: String(doc._id),
  at: iso(doc.at),
  day: doc.day,
  substance: doc.substance,
  amount: doc.amount || 0,
  trigger: doc.trigger || "",
  feelingBefore: doc.feelingBefore || "",
  context: decryptText(doc.contextEnc),
  debrief: decryptJson(doc.debriefEnc, null),
  restart: doc.restart,
  source: doc.source,
});

const toClientMessage = (doc, lang) => ({
  id: String(doc._id),
  role: doc.role,
  mode: doc.mode,
  text: decryptText(doc.textEnc),
  risk: doc.risk || "none",
  suggestedTool: doc.suggestedTool || "none",
  crisis: doc.role === "coach" ? crisisPayload({ level: doc.risk, type: doc.riskType }, lang) : null,
  createdAt: iso(doc.createdAt),
});

const decorateSubstance = (substance, stats, lang) => {
  const meta = substanceMeta(substance.key);
  const timeline = localize(timelineFor(substance.key), lang);
  const milestoneLabel = (days) => {
    const milestone = MILESTONES.find((item) => item.days === days);
    return milestone ? localize(milestone.label, lang) : null;
  };
  return {
    ...stats,
    key: substance.key,
    name: substance.key === "other" && substance.customName ? substance.customName : localize(meta.name, lang),
    unit: localize(meta.unit, lang),
    icon: meta.icon,
    safetyClass: meta.safetyClass,
    approach: substance.approach,
    primary: Boolean(substance.primary),
    quitDate: iso(substance.quitDate),
    streakStart: iso(substance.streakStart || substance.quitDate),
    costPerUnit: substance.costPerUnit || 0,
    milestone: { ...stats.milestone, reachedLabel: milestoneLabel(stats.milestone.reachedDays), nextLabel: milestoneLabel(stats.milestone.nextDays) },
    health: {
      ...stats.health,
      last: stats.health.reachedIndex >= 0 ? timeline[stats.health.reachedIndex] : null,
      next: stats.health.nextIndex !== null ? timeline[stats.health.nextIndex] : null,
    },
  };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

/** Validates onboarding/profile input. Returns the $set update and any errors. */
const normalizeProfileInput = (body = {}, existing = null, now = new Date()) => {
  const errors = [];
  const update = {};
  const nowMs = new Date(now).getTime();

  if (body.substances !== undefined) {
    if (!Array.isArray(body.substances) || !body.substances.length || body.substances.length > 6) {
      errors.push("Choose between 1 and 6 substances");
    } else {
      const seen = new Set();
      const substances = [];
      for (const raw of body.substances) {
        const key = String(raw?.key || "");
        if (!SUBSTANCE_KEYS.includes(key) || seen.has(key)) {
          errors.push("Each substance can only be added once");
          continue;
        }
        seen.add(key);
        const meta = substanceMeta(key);
        const safety = SAFETY_CLASSES[meta.safetyClass];
        const approach = safety.approaches.includes(raw?.approach) ? raw.approach : safety.defaultApproach;
        let quitDate = raw?.quitDate ? toDate(raw.quitDate) : new Date(nowMs);
        if (!quitDate) {
          errors.push("Choose a valid quit date");
          continue;
        }
        // "Stop now" sent from a phone whose clock runs slightly fast.
        if (quitDate.getTime() > nowMs && quitDate.getTime() - nowMs < 10 * 60 * 1000) quitDate = new Date(nowMs);
        if (quitDate.getTime() > nowMs + 31 * DAY_MS) errors.push("Choose a quit date within the next 30 days");
        if (quitDate.getTime() < nowMs - 20 * 365 * DAY_MS) errors.push("That quit date is too far in the past");
        const previous = existing?.substances?.find((item) => item.key === key);
        const quitChanged = !previous || new Date(previous.quitDate).getTime() !== quitDate.getTime();
        const answers = body.screenerAnswers?.[key];
        const scored = Array.isArray(answers) ? scoreScreener(meta.screener, answers, key) : null;
        const screener = scored || (previous?.screener?.tool ? previous.screener : null);
        substances.push(
          compact({
            key,
            customName: key === "other" ? clip(raw?.customName, 60) : "",
            primary: Boolean(raw?.primary),
            amountPerDay: toNumber(raw?.amountPerDay, 0, 1000, meta.defaultAmount),
            daysPerWeek: toNumber(raw?.daysPerWeek, 0, 7, 7),
            costPerUnit: toNumber(raw?.costPerUnit, 0, 1000000, 0),
            yearsUsing: toNumber(raw?.yearsUsing, 0, 80, undefined),
            wakeUse: ["5min", "30min", "60min", "later"].includes(raw?.wakeUse) ? raw.wakeUse : "",
            approach,
            quitDate,
            streakStart: quitChanged ? quitDate : new Date(previous.streakStart || previous.quitDate),
            longestStreakDays: previous?.longestStreakDays || 0,
            bankedCleanDays: previous?.bankedCleanDays || 0,
            screener: screener ? { tool: screener.tool, score: screener.score, severity: screener.severity || "" } : { tool: meta.screener, severity: "" },
          }),
        );
      }
      let primaryFound = false;
      substances.forEach((substance) => {
        if (substance.primary && !primaryFound) primaryFound = true;
        else substance.primary = false;
      });
      if (substances.length && !primaryFound) substances[0].primary = true;
      if (substances.length) update.substances = substances;
    }
  }

  if (body.readiness !== undefined) {
    update.readiness = { importance: toInt(body.readiness?.importance, 0, 10, 8), confidence: toInt(body.readiness?.confidence, 0, 10, 5) };
  }
  if (body.reasonKeys !== undefined) update.reasonKeys = pickKeys(body.reasonKeys, REASON_KEYS, REASON_KEYS.length);
  if (body.reasons !== undefined) update.reasonsEnc = encryptText(clip(body.reasons, 1000));
  if (body.letter !== undefined) update.letterEnc = encryptText(clip(body.letter, 2000));
  if (body.triggers !== undefined) update.triggers = pickKeys(body.triggers, TRIGGER_KEYS, TRIGGER_KEYS.length);
  if (body.supportContacts !== undefined) {
    const contacts = (Array.isArray(body.supportContacts) ? body.supportContacts : [])
      .slice(0, 5)
      .map((contact) => ({
        name: clip(contact?.name, 60),
        phone: clip(String(contact?.phone || "").replace(/[^\d+\-\s()]/g, ""), 24),
        relation: clip(contact?.relation, 40),
      }))
      .filter((contact) => contact.name || contact.phone);
    update.supportContactsEnc = contacts.length ? encryptJson(contacts) : "";
  }
  if (body.settings !== undefined) {
    update.settings = {
      aiEnabled: bool(body.settings?.aiEnabled, existing?.settings?.aiEnabled !== false),
      discreet: bool(body.settings?.discreet, existing?.settings?.discreet !== false),
      riskNudges: bool(body.settings?.riskNudges, Boolean(existing?.settings?.riskNudges)),
    };
  }
  if (body.language !== undefined) update.language = ["auto", "en", "bn"].includes(body.language) ? body.language : "auto";
  if (body.timezone !== undefined) {
    if (isValidTimezone(body.timezone)) update.timezone = body.timezone;
    else errors.push("Invalid timezone");
  }
  if (body.currency !== undefined) update.currency = clip(body.currency, 8).toUpperCase() || "BDT";
  if (body.onboardingCompleted !== undefined) update.onboardingCompleted = Boolean(body.onboardingCompleted);
  return { update, errors };
};

/** Keeps a user-edited plan well-formed; the safety note always stays curated. */
const sanitizeClientPlan = (plan, existing, safetyNote) => {
  if (!plan || typeof plan !== "object") return null;
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    summary: clip(plan.summary, 500),
    safetyNote: existing?.safetyNote || safetyNote,
    ifThen: list(plan.ifThen)
      .map((item) => ({ trigger: clip(item?.trigger, 120), action: clip(item?.action, 240) }))
      .filter((item) => item.action)
      .slice(0, 10),
    tools: pickKeys(plan.tools, TOOL_KEYS, TOOL_KEYS.length),
    checklist: list(plan.checklist)
      .map((item) => ({ text: clip(typeof item === "string" ? item : item?.text, 200), done: Boolean(item?.done) }))
      .filter((item) => item.text)
      .slice(0, 15),
    weeklyGoals: list(plan.weeklyGoals)
      .map((item, index) => ({ week: toInt(item?.week, 1, 52, index + 1), goal: clip(item?.goal, 220), expect: clip(item?.expect, 240), done: Boolean(item?.done) }))
      .filter((item) => item.goal)
      .slice(0, 8),
    rewardIdea: clip(plan.rewardIdea, 240),
    rewardGoal: plan.rewardGoal && typeof plan.rewardGoal === "object" ? { title: clip(plan.rewardGoal.title, 80), amount: toNumber(plan.rewardGoal.amount, 0, 100000000, 0) } : existing?.rewardGoal || null,
    source: existing?.source || "curated",
  };
};

// ---------------------------------------------------------------------------
// Dashboard assembly (pure; exported for tests)
// ---------------------------------------------------------------------------
const buildDashboard = ({ profile, lapses = [], checkins = [], cravings = [], totals = {}, now = new Date(), lang = "en", daily = null }) => {
  const timezone = safeTimezone(profile.timezone);
  const nowDate = new Date(now);
  const todayKey = dayKey(nowDate, timezone);
  const statsByKey = {};
  const substances = (profile.substances || []).map((substance) => {
    const lapseDayKeys = lapses.filter((lapse) => lapse.substance === substance.key).map((lapse) => lapse.day);
    const stats = substanceStats(substance, { now: nowDate, lapseDayKeys, timezone });
    statsByKey[substance.key] = stats;
    return decorateSubstance(substance, stats, lang);
  });
  const weekAgo = nowDate.getTime() - 7 * DAY_MS;
  const recentCheckins = checkins.filter((checkin) => checkin.day >= addDaysToKey(todayKey, -6));
  const recentCravings = cravings.filter((craving) => new Date(craving.at).getTime() >= weekAgo);
  const lapsesLast30 = lapses.filter((lapse) => new Date(lapse.at).getTime() >= nowDate.getTime() - 30 * DAY_MS).length;
  const todayCheckin = checkins.find((checkin) => checkin.day === todayKey);
  const longestStreakDays = substances.reduce((max, substance) => Math.max(max, substance.longestStreakDays), 0);
  return {
    statsByKey,
    view: {
      serverTime: nowDate.toISOString(),
      todayKey,
      substances,
      totals: {
        moneySaved: substances.reduce((sum, substance) => sum + substance.moneySaved, 0),
        cravingsResisted: totals.cravingsResisted || 0,
        cravingsLogged: totals.cravingsLogged || 0,
        checkinCount: totals.checkinCount || 0,
        checkinStreak: checkinStreak(checkins.map((checkin) => checkin.day), todayKey),
        longestStreakDays,
        totalCleanDays: substances.reduce((max, substance) => Math.max(max, substance.totalCleanDays), 0),
      },
      today: { checkin: todayCheckin ? toClientCheckin(todayCheckin) : null },
      daily,
      recent: recentStats({ checkins: recentCheckins, cravings: recentCravings }),
      toolOrder: rankTools(cravings),
      proHelp: professionalHelpReasons({ substances: profile.substances || [], lastCrisisAt: profile.lastCrisisAt, lapsesLast30, now: nowDate }),
      stage: stageOfChange({ importance: profile.readiness?.importance ?? 8, substances: profile.substances || [], now: nowDate }),
      badgeCandidates: earnedBadgeKeys({ longestStreakDays, cravingsResisted: totals.cravingsResisted || 0, checkinCount: totals.checkinCount || 0 }),
    },
  };
};

const CONTENT_CACHE = {};
const contentPayload = (lang) => {
  if (!CONTENT_CACHE[lang]) {
    CONTENT_CACHE[lang] = localize(
      {
        substances: SUBSTANCES.map(({ key, safetyClass, screener, icon, name, unit, unitOne, defaultAmount }) => ({ key, safetyClass, screener, icon, name, unit, unitOne, defaultAmount })),
        safetyClasses: SAFETY_CLASSES,
        screeners: Object.fromEntries(
          Object.entries(SCREENERS).map(([tool, screener]) => [
            tool,
            { title: screener.title, questions: screener.questions.map((question) => ({ text: question.text, options: question.options.map((option) => option.label) })) },
          ]),
        ),
        triggers: TRIGGERS.map(({ key, label }) => ({ key, label })),
        reasons: REASONS,
        halt: HALT,
        milestones: MILESTONES,
        badges: BADGES,
        timelines: TIMELINES,
        helplines: HELPLINES,
        crisisMessages: CRISIS_MESSAGES,
        tools: TOOL_KEYS,
      },
      lang,
    );
  }
  return CONTENT_CACHE[lang];
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const createRecoveryController = ({ models = {}, ai = defaultAi, offlineAi = defaultAi.offlineRecoveryAi, clock = () => new Date() } = {}) => {
  const RecoveryProfile = models.RecoveryProfile || RecoveryProfileModel;
  const RecoveryCheckIn = models.RecoveryCheckIn || RecoveryCheckInModel;
  const RecoveryCraving = models.RecoveryCraving || RecoveryCravingModel;
  const RecoveryLapse = models.RecoveryLapse || RecoveryLapseModel;
  const RecoveryChatMessage = models.RecoveryChatMessage || RecoveryChatMessageModel;

  // Soft per-person limit on AI calls; over the limit, curated responses are used.
  const aiCalls = new Map();
  const allowAi = (userId) => {
    const key = String(userId);
    const now = Date.now();
    const recent = (aiCalls.get(key) || []).filter((time) => now - time < AI_WINDOW_MS);
    const allowed = recent.length < AI_CALLS_PER_WINDOW;
    if (allowed) recent.push(now);
    aiCalls.set(key, recent);
    return allowed;
  };
  const aiFor = (profile, userId) => (profile?.settings?.aiEnabled === false || !allowAi(userId) ? offlineAi : ai);

  const loadProfile = (userId) => RecoveryProfile.findOne({ user: userId }).lean();

  const loadActivity = async (userId, profile, now) => {
    const timezone = safeTimezone(profile.timezone);
    const todayKey = dayKey(now, timezone);
    const [lapses, checkins, cravings] = await Promise.all([
      RecoveryLapse.find({ user: userId }).sort({ at: -1 }).limit(1000).lean(),
      RecoveryCheckIn.find({ user: userId, day: { $gte: addDaysToKey(todayKey, -60) } }).sort({ day: -1 }).lean(),
      RecoveryCraving.find({ user: userId, at: { $gte: new Date(now.getTime() - 90 * DAY_MS) } }).sort({ at: -1 }).limit(500).lean(),
    ]);
    return { lapses, checkins, cravings, timezone, todayKey };
  };

  const counts = async (userId) => {
    const [cravingsResisted, cravingsLogged, checkinCount] = await Promise.all([
      RecoveryCraving.countDocuments({ user: userId, outcome: "resisted" }),
      RecoveryCraving.countDocuments({ user: userId }),
      RecoveryCheckIn.countDocuments({ user: userId }),
    ]);
    return { cravingsResisted, cravingsLogged, checkinCount };
  };

  const aiContextFor = (profile, activity, now, { withSummary = false } = {}) => {
    const { statsByKey, view } = buildDashboard({ profile, ...activity, now });
    return defaultAi.buildContext({
      profile: { ...profile, reasonsText: decryptText(profile.reasonsEnc), supportContacts: decryptJson(profile.supportContactsEnc, []) },
      statsByKey,
      recent: view.recent,
      lastLapse: activity.lapses[0] || null,
      toolOrder: view.toolOrder,
      stage: view.stage,
      conversationSummary: withSummary ? decryptText(profile.chatSummaryEnc) : "",
      now,
      timezone: activity.timezone,
    });
  };

  const grantBadges = async (userId, profile, candidates, now) => {
    const have = new Set((profile.badges || []).map((badge) => badge.key));
    const fresh = [...new Set(candidates)].filter((key) => !have.has(key) && BADGES[key]);
    if (fresh.length) {
      await RecoveryProfile.updateOne({ user: userId }, { $push: { badges: { $each: fresh.map((key) => ({ key, at: now })) } } });
    }
    return fresh;
  };

  /** Records a slip and returns the updated substances array (not yet saved). */
  const recordLapse = async ({ userId, profile, timezone, now, data, priorLapses = [] }) => {
    const substance = profile.substances.find((item) => item.key === data.substance);
    const day = dayKey(data.at, timezone);
    const priorDays = priorLapses.filter((lapse) => lapse.substance === data.substance).map((lapse) => lapse.day);
    const update = applyLapse(substance, data.at, {
      restart: data.restart || "continue",
      newQuitDate: data.newQuitDate,
      now,
      timezone,
      lapseDayKeys: [...priorDays, day],
    });
    const substances = profile.substances.map((item) => (item.key === data.substance ? { ...item, ...update } : item));
    const lapse = plain(
      await RecoveryLapse.create({
        user: userId,
        at: data.at,
        day,
        substance: data.substance,
        amount: data.amount || 0,
        trigger: data.trigger || "",
        feelingBefore: data.feelingBefore || "",
        contextEnc: data.context ? encryptText(data.context) : "",
        restart: data.restart || "continue",
        source: data.source || "lapse",
      }),
    );
    return { lapse, substances };
  };

  const loadHistory = async (userId, limit) =>
    (await RecoveryChatMessage.find({ user: userId }).sort({ createdAt: -1 }).limit(limit).lean())
      .reverse()
      .map((message) => ({ role: message.role, text: decryptText(message.textEnc) }));

  const refreshSummary = async (userId, profile) => {
    const recent = await RecoveryChatMessage.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(Math.max(SUMMARY_EVERY_MESSAGES, profile.chatMessagesSinceSummary || 0))
      .lean();
    const turns = recent.reverse().map((message) => ({ role: message.role, text: decryptText(message.textEnc) }));
    const summary = await aiFor(profile, userId).summarizeConversation({ previousSummary: decryptText(profile.chatSummaryEnc), turns });
    await RecoveryProfile.updateOne({ user: userId }, { $set: { chatSummaryEnc: encryptText(summary), chatMessagesSinceSummary: 0 } });
  };

  const getContent = (req, res) => {
    const lang = normalizeLang(req.query?.lang);
    return res.json({ success: true, lang, ...contentPayload(lang) });
  };

  const getResources = (req, res) => res.json({ success: true, helplines: contentPayload(normalizeLang(req.query?.lang)).helplines });

  const getProfile = async (req, res) => {
    try {
      return res.json({ success: true, profile: toClientProfile(await loadProfile(owner(req))) });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const saveProfile = async (req, res) => {
    try {
      const userId = owner(req);
      const existing = await loadProfile(userId);
      const { update, errors } = normalizeProfileInput(req.body || {}, existing, clock());
      if (errors.length) return badRequest(res, errors[0]);
      if (!existing) {
        if (!update.substances) return badRequest(res, "Choose at least one substance to track");
        await RecoveryProfile.create({ user: userId, ...update });
      } else if (Object.keys(update).length) {
        await RecoveryProfile.updateOne({ user: userId }, { $set: update }, { runValidators: true });
      }
      return res.json({ success: true, profile: toClientProfile(await loadProfile(userId)) });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const dashboard = async (req, res) => {
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return res.json({ success: true, profile: null });
      const now = clock();
      const lang = resolveLang(req, profile);
      const [activity, totals] = await Promise.all([loadActivity(userId, profile, now), counts(userId)]);
      const cached = profile.daily?.dayKey === activity.todayKey ? decryptJson(profile.daily.noteEnc, null) : null;
      const daily = cached && cached.lang === lang ? { note: cached.note, mission: cached.mission, source: cached.source } : null;
      const { view } = buildDashboard({ profile, ...activity, totals, now, lang, daily });
      const { badgeCandidates, ...rest } = view;
      const newBadges = await grantBadges(userId, profile, badgeCandidates, now);
      const badges = [...(profile.badges || []), ...newBadges.map((key) => ({ key, at: now }))];
      return res.json({
        success: true,
        ...rest,
        profile: toClientProfile({ ...profile, badges }),
        points: profile.points || 0,
        badges: badgeView(badges, lang),
        newBadges: badgeView(newBadges.map((key) => ({ key, at: now })), lang),
      });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const daily = async (req, res) => {
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const now = clock();
      const lang = resolveLang(req, profile);
      const todayKey = dayKey(now, safeTimezone(profile.timezone));
      const cached = profile.daily?.dayKey === todayKey ? decryptJson(profile.daily.noteEnc, null) : null;
      if (cached && cached.lang === lang) return res.json({ success: true, note: cached.note, mission: cached.mission, source: cached.source });
      const activity = await loadActivity(userId, profile, now);
      const note = await aiFor(profile, userId).dailyNote({
        context: aiContextFor(profile, activity, now),
        lang,
        dayIndex: Math.floor(new Date(`${todayKey}T00:00:00.000Z`).getTime() / DAY_MS),
      });
      await RecoveryProfile.updateOne({ user: userId }, { $set: { daily: { dayKey: todayKey, noteEnc: encryptJson({ ...note, lang }) } } });
      return res.json({ success: true, note: note.note, mission: note.mission, source: note.source });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const generatePlan = async (req, res) => {
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const now = clock();
      const lang = resolveLang(req, profile);
      const activity = await loadActivity(userId, profile, now);
      const plan = await aiFor(profile, userId).generatePlan({ context: aiContextFor(profile, activity, now), lang });
      const previous = decryptJson(profile.planEnc, null);
      const saved = { ...plan, rewardGoal: previous?.rewardGoal || null };
      const firstPlan = !profile.planGeneratedAt;
      await RecoveryProfile.updateOne(
        { user: userId },
        { $set: { planEnc: encryptJson(saved), planSource: plan.source, planGeneratedAt: now }, ...(firstPlan ? { $inc: { points: POINTS.plan } } : {}) },
      );
      return res.json({ success: true, plan: saved, pointsEarned: firstPlan ? POINTS.plan : 0 });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const updatePlan = async (req, res) => {
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const lang = resolveLang(req, profile);
      const classes = [...new Set(profile.substances.map((substance) => safetyClassOf(substance.key)))];
      const plan = sanitizeClientPlan(req.body?.plan, decryptJson(profile.planEnc, null), defaultAi.safetyNoteFor(classes, lang));
      if (!plan) return badRequest(res, "Plan is not valid");
      await RecoveryProfile.updateOne({ user: userId }, { $set: { planEnc: encryptJson(plan), planSource: plan.source } });
      return res.json({ success: true, plan });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const listCheckins = async (req, res) => {
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const days = toInt(req.query?.days, 1, 365, 30);
      const since = addDaysToKey(dayKey(clock(), safeTimezone(profile.timezone)), -(days - 1));
      const checkins = await RecoveryCheckIn.find({ user: userId, day: { $gte: since } }).sort({ day: -1 }).lean();
      return res.json({ success: true, checkins: checkins.map(toClientCheckin) });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const saveCheckin = async (req, res) => {
    const body = req.body || {};
    const mood = toInt(body.mood, 1, 5, null);
    const craving = toInt(body.craving, 0, 10, null);
    if (mood === null || craving === null) return badRequest(res, "Mood and craving level are required");
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const now = clock();
      const lang = resolveLang(req, profile);
      const timezone = safeTimezone(profile.timezone);
      const day = dayKey(now, timezone);
      const tracked = profile.substances.map((substance) => substance.key);
      const used = (Array.isArray(body.used) ? body.used : [])
        .map((item) => ({ substance: String(item?.substance || ""), amount: toNumber(item?.amount, 0, 1000, 0) }))
        .filter((item) => tracked.includes(item.substance))
        .slice(0, 6);
      const fields = compact({
        used,
        mood,
        craving,
        stress: toInt(body.stress, 1, 5, undefined),
        sleepHours: toNumber(body.sleepHours, 0, 24, undefined),
        halt: pickKeys(body.halt, HALT_KEYS, HALT_KEYS.length),
        triggers: pickKeys(body.triggers, TRIGGER_KEYS, 8),
      });
      const note = clip(body.note, 1000);
      const detected = detectCrisis(note);
      const [existing, activity] = await Promise.all([RecoveryCheckIn.findOne({ user: userId, day }).lean(), loadActivity(userId, profile, now)]);
      const reflection = await aiFor(profile, userId).checkinReflection({ checkin: { ...fields, note }, context: aiContextFor(profile, activity, now), lang });
      const risk = maxRisk(detected, { level: reflection.risk, type: reflection.risk === "none" ? "none" : "distress" });
      const saved = await RecoveryCheckIn.findOneAndUpdate(
        { user: userId, day },
        {
          $set: {
            ...fields,
            noteEnc: encryptText(note),
            reflectionEnc: encryptJson({ reflection: reflection.reflection, microGoal: reflection.microGoal, source: reflection.source }),
            risk: risk.level,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      ).lean();

      // Use reported in a check-in is recorded as a slip so the counters stay honest.
      let substances = profile.substances;
      const lapsesCreated = [];
      for (const entry of used.filter((item) => item.amount > 0)) {
        if (activity.lapses.some((lapse) => lapse.substance === entry.substance && lapse.day === day)) continue;
        const substance = substances.find((item) => item.key === entry.substance);
        if (new Date(substance.quitDate).getTime() > now.getTime()) continue;
        const result = await recordLapse({
          userId,
          profile: { ...profile, substances },
          timezone,
          now,
          data: { substance: entry.substance, amount: entry.amount, at: now, trigger: fields.triggers?.[0] || "", source: "checkin" },
          priorLapses: activity.lapses,
        });
        substances = result.substances;
        lapsesCreated.push(entry.substance);
      }

      const set = {};
      if (lapsesCreated.length) set.substances = substances;
      if (risk.level === "crisis") set.lastCrisisAt = now;
      const pointsEarned = existing ? 0 : POINTS.checkin;
      if (Object.keys(set).length || pointsEarned) {
        await RecoveryProfile.updateOne({ user: userId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(pointsEarned ? { $inc: { points: pointsEarned } } : {}) });
      }
      const totals = await counts(userId);
      const newBadges = await grantBadges(userId, profile, earnedBadgeKeys({ ...totals }), now);
      return res.json({
        success: true,
        checkin: toClientCheckin(saved),
        crisis: crisisPayload(risk, lang),
        lapsesCreated,
        pointsEarned,
        newBadges: badgeView(newBadges, lang),
      });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const listCravings = async (req, res) => {
    try {
      const days = toInt(req.query?.days, 1, 365, 30);
      const cravings = await RecoveryCraving.find({ user: owner(req), at: { $gte: new Date(clock().getTime() - days * DAY_MS) } })
        .sort({ at: -1 })
        .limit(1000)
        .lean();
      return res.json({ success: true, cravings: cravings.map(toClientCraving) });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const logCraving = async (req, res) => {
    const body = req.body || {};
    const clientId = clip(body.clientId, 64);
    const intensityStart = toInt(body.intensityStart, 1, 10, null);
    if (!clientId) return badRequest(res, "clientId is required");
    if (intensityStart === null) return badRequest(res, "Rate the craving from 1 to 10");
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const now = clock();
      const lang = resolveLang(req, profile);
      const duplicate = async () => {
        const existing = await RecoveryCraving.findOne({ user: userId, clientId }).lean();
        return res.json({ success: true, duplicate: true, craving: existing ? toClientCraving(existing) : null, pointsEarned: 0, newBadges: [] });
      };
      if (await RecoveryCraving.findOne({ user: userId, clientId }).lean()) return duplicate();
      let at = toDate(body.at) || now;
      if (at.getTime() > now.getTime() + 5 * 60 * 1000) at = now;
      if (at.getTime() < now.getTime() - 30 * DAY_MS) return badRequest(res, "This craving is too old to log");
      const tracked = profile.substances.map((substance) => substance.key);
      const primary = (profile.substances.find((substance) => substance.primary) || profile.substances[0]).key;
      const outcome = ["resisted", "used", "unsure"].includes(body.outcome) ? body.outcome : "unsure";
      let created;
      try {
        created = plain(
          await RecoveryCraving.create(
            compact({
              user: userId,
              clientId,
              at,
              substance: tracked.includes(body.substance) ? body.substance : primary,
              intensityStart,
              intensityEnd: toInt(body.intensityEnd, 0, 10, undefined),
              trigger: TRIGGER_KEYS.includes(body.trigger) ? body.trigger : "",
              tools: pickKeys(body.tools, TOOL_KEYS, TOOL_KEYS.length),
              durationSec: toInt(body.durationSec, 0, 24 * 3600, 0),
              outcome,
            }),
          ),
        );
      } catch (error) {
        if (error?.code === 11000) return duplicate();
        throw error;
      }
      const pointsEarned = POINTS.sos_done + (outcome === "resisted" ? POINTS.craving_resisted : 0);
      const recent = await RecoveryCraving.find({ user: userId, at: { $gte: new Date(now.getTime() - 60 * DAY_MS) } }).lean();
      await RecoveryProfile.updateOne({ user: userId }, { $inc: { points: pointsEarned }, $set: { riskHours: riskHours(recent, profile.timezone) } });
      const newBadges = await grantBadges(userId, profile, earnedBadgeKeys({ ...(await counts(userId)) }), now);
      return res.json({ success: true, duplicate: false, craving: toClientCraving(created), pointsEarned, newBadges: badgeView(newBadges, lang) });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const listLapses = async (req, res) => {
    try {
      const days = toInt(req.query?.days, 1, 3650, 90);
      const lapses = await RecoveryLapse.find({ user: owner(req), at: { $gte: new Date(clock().getTime() - days * DAY_MS) } })
        .sort({ at: -1 })
        .limit(500)
        .lean();
      return res.json({ success: true, lapses: lapses.map(toClientLapse) });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const logLapse = async (req, res) => {
    const body = req.body || {};
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const now = clock();
      const lang = resolveLang(req, profile);
      const timezone = safeTimezone(profile.timezone);
      const key = String(body.substance || "");
      const substance = profile.substances.find((item) => item.key === key);
      if (!substance) return badRequest(res, "Choose one of the substances you are tracking");
      let at = toDate(body.at) || now;
      if (at.getTime() > now.getTime()) at = now;
      if (at.getTime() < new Date(substance.quitDate).getTime()) return badRequest(res, "That was before your quit date, so it doesn't count as a slip");
      const restart = body.restart === "new_date" ? "new_date" : "continue";
      let newQuitDate = null;
      if (restart === "new_date") {
        newQuitDate = toDate(body.newQuitDate);
        if (!newQuitDate || newQuitDate.getTime() < now.getTime() - DAY_MS || newQuitDate.getTime() > now.getTime() + 31 * DAY_MS) {
          return badRequest(res, "Choose a new quit date within the next 30 days");
        }
      }
      const context = clip(body.context, 1500);
      const trigger = TRIGGER_KEYS.includes(body.trigger) ? body.trigger : "";
      const amount = toNumber(body.amount, 0, 1000, 0);
      const feelingBefore = clip(body.feelingBefore, 40);
      const detected = detectCrisis(context);

      const activity = await loadActivity(userId, profile, now);
      const { lapse, substances } = await recordLapse({
        userId,
        profile,
        timezone,
        now,
        data: { substance: key, at, amount, trigger, feelingBefore, context, restart, newQuitDate, source: "lapse" },
        priorLapses: activity.lapses,
      });
      const updatedProfile = { ...profile, substances };
      const updatedActivity = { ...activity, lapses: [lapse, ...activity.lapses] };
      const debrief = await aiFor(profile, userId).lapseDebrief({
        lapse: { substance: key, amount, trigger, feelingBefore, context, at },
        context: aiContextFor(updatedProfile, updatedActivity, now),
        lang,
      });
      const risk = maxRisk(detected, { level: debrief.risk, type: debrief.risk === "none" ? "none" : "distress" });
      await RecoveryLapse.updateOne({ _id: lapse._id }, { $set: { debriefEnc: encryptJson(debrief) } });
      await RecoveryProfile.updateOne({ user: userId }, { $set: { substances, ...(risk.level === "crisis" ? { lastCrisisAt: now } : {}) } });
      const newBadges = activity.lapses.length === 0 ? await grantBadges(userId, profile, ["honest_restart"], now) : [];

      const updatedSubstance = substances.find((item) => item.key === key);
      const lapseDayKeys = updatedActivity.lapses.filter((item) => item.substance === key).map((item) => item.day);
      return res.json({
        success: true,
        lapse: toClientLapse({ ...lapse, debriefEnc: encryptJson(debrief) }),
        debrief,
        safety: { safetyClass: safetyClassOf(key), text: localize(SAFETY_CLASSES[safetyClassOf(key)].lapseSafety, lang) },
        crisis: crisisPayload(risk, lang),
        substance: decorateSubstance(updatedSubstance, substanceStats(updatedSubstance, { now, lapseDayKeys, timezone }), lang),
        newBadges: badgeView(newBadges, lang),
      });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const coach = async (req, res) => {
    const message = clip(req.body?.message, 1000);
    if (!message) return badRequest(res, "Write a message first");
    const mode = ["coach", "sos", "lapse"].includes(req.body?.mode) ? req.body.mode : "coach";
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const now = clock();
      const lang = resolveLang(req, profile);
      if (profile.settings?.aiEnabled === false) {
        return res.status(403).json({
          success: false,
          code: "AI_DISABLED",
          message: lang === "bn" ? "সাথী বন্ধ করা আছে। রিকভারি সেটিংস থেকে চালু করতে পারেন।" : "Sathi is turned off. You can turn it on in Recovery settings.",
        });
      }
      const detected = detectCrisis(message);
      const aiMode = detected.level === "crisis" ? "crisis" : mode;
      const [activity, history] = await Promise.all([loadActivity(userId, profile, now), loadHistory(userId, 10)]);
      const reply = await aiFor(profile, userId).coachReply({
        message,
        mode: aiMode,
        history,
        context: aiContextFor(profile, activity, now, { withSummary: true }),
        lang,
      });
      const risk = maxRisk(detected, { level: reply.risk, type: reply.riskType });
      const crisis = crisisPayload(risk, lang);
      const suggestedTool = crisis ? "help" : reply.suggestedTool;
      await RecoveryChatMessage.insertMany([
        { user: userId, role: "user", mode: aiMode, textEnc: encryptText(message), risk: detected.level, riskType: detected.type, createdAt: now },
        { user: userId, role: "coach", mode: aiMode, textEnc: encryptText(reply.reply), risk: risk.level, riskType: risk.type, suggestedTool, createdAt: new Date(now.getTime() + 1) },
      ]);
      const updated = await RecoveryProfile.findOneAndUpdate(
        { user: userId },
        { $inc: { chatMessagesSinceSummary: 2 }, ...(crisis ? { $set: { lastCrisisAt: now } } : {}) },
        { new: true },
      ).lean();
      if (updated && updated.chatMessagesSinceSummary >= SUMMARY_EVERY_MESSAGES) {
        refreshSummary(userId, updated).catch((error) => console.warn("[recovery] summary refresh failed:", error?.name || "Error"));
      }
      return res.json({ success: true, reply: reply.reply, risk: risk.level, riskType: risk.type, suggestedTool, crisis, source: reply.source });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const coachHistory = async (req, res) => {
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      const lang = resolveLang(req, profile);
      const messages = await RecoveryChatMessage.find({ user: userId }).sort({ createdAt: -1 }).limit(60).lean();
      return res.json({ success: true, messages: messages.reverse().map((message) => toClientMessage(message, lang)) });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const clearCoachHistory = async (req, res) => {
    try {
      const userId = owner(req);
      await RecoveryChatMessage.deleteMany({ user: userId });
      await RecoveryProfile.updateOne({ user: userId }, { $set: { chatSummaryEnc: "", chatMessagesSinceSummary: 0 } });
      return res.json({ success: true });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const exportData = async (req, res) => {
    try {
      const userId = owner(req);
      const profile = await loadProfile(userId);
      if (!profile) return notSetUp(res);
      const lang = resolveLang(req, profile);
      const [checkins, cravings, lapses, messages] = await Promise.all([
        RecoveryCheckIn.find({ user: userId }).sort({ day: -1 }).lean(),
        RecoveryCraving.find({ user: userId }).sort({ at: -1 }).lean(),
        RecoveryLapse.find({ user: userId }).sort({ at: -1 }).lean(),
        RecoveryChatMessage.find({ user: userId }).sort({ createdAt: 1 }).lean(),
      ]);
      return res.json({
        success: true,
        exportedAt: clock().toISOString(),
        profile: toClientProfile(profile),
        checkins: checkins.map(toClientCheckin),
        cravings: cravings.map(toClientCraving),
        lapses: lapses.map(toClientLapse),
        coachMessages: messages.map((message) => toClientMessage(message, lang)),
      });
    } catch (error) {
      return handleError(res, error);
    }
  };

  const reset = async (req, res) => {
    try {
      const userId = owner(req);
      await Promise.all([
        RecoveryProfile.deleteMany({ user: userId }),
        RecoveryCheckIn.deleteMany({ user: userId }),
        RecoveryCraving.deleteMany({ user: userId }),
        RecoveryLapse.deleteMany({ user: userId }),
        RecoveryChatMessage.deleteMany({ user: userId }),
      ]);
      return res.json({ success: true });
    } catch (error) {
      return handleError(res, error);
    }
  };

  return {
    getContent,
    getResources,
    getProfile,
    saveProfile,
    dashboard,
    daily,
    generatePlan,
    updatePlan,
    listCheckins,
    saveCheckin,
    listCravings,
    logCraving,
    listLapses,
    logLapse,
    coach,
    coachHistory,
    clearCoachHistory,
    exportData,
    reset,
  };
};

module.exports = {
  ...createRecoveryController(),
  createRecoveryController,
  normalizeProfileInput,
  sanitizeClientPlan,
  buildDashboard,
  toClientProfile,
  crisisPayload,
};
