const assert = require("node:assert/strict");
const test = require("node:test");
const { createRecoveryController, normalizeProfileInput } = require("./recoveryController");
const { createRecoveryAi } = require("../services/recoveryAi");

// ---------------------------------------------------------------------------
// Minimal in-memory stand-in for the Mongoose model methods the controller uses.
// ---------------------------------------------------------------------------
const get = (object, path) => path.split(".").reduce((value, key) => (value == null ? value : value[key]), object);
const setPath = (object, path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((current, key) => (current[key] = current[key] || {}), object);
  target[last] = value;
};
const isDateLike = (value) => value instanceof Date;
const same = (a, b) => (isDateLike(a) || isDateLike(b) ? new Date(a).getTime() === new Date(b).getTime() : String(a) === String(b));
const compare = (a, b) => (isDateLike(a) || isDateLike(b) ? new Date(a) - new Date(b) : a < b ? -1 : a > b ? 1 : 0);

const makeModel = ({ unique = [] } = {}) => {
  const docs = [];
  let sequence = 0;
  const matches = (doc, filter = {}) =>
    Object.entries(filter).every(([key, condition]) => {
      const value = get(doc, key);
      if (condition && typeof condition === "object" && !isDateLike(condition)) {
        return Object.entries(condition).every(([op, arg]) => {
          if (op === "$gte") return value !== undefined && compare(value, arg) >= 0;
          if (op === "$lt") return value !== undefined && compare(value, arg) < 0;
          throw new Error(`Unsupported operator ${op}`);
        });
      }
      return same(value, condition);
    });
  const applyUpdate = (doc, update) => {
    for (const [key, value] of Object.entries(update.$set || {})) setPath(doc, key, structuredClone(value));
    for (const [key, value] of Object.entries(update.$inc || {})) setPath(doc, key, (get(doc, key) || 0) + value);
    for (const [key, value] of Object.entries(update.$push || {})) setPath(doc, key, [...(get(doc, key) || []), ...structuredClone(value.$each || [value])]);
  };
  const query = (run) => {
    let sortSpec = null;
    let limit = null;
    const finish = () => {
      let result = run();
      if (Array.isArray(result)) {
        if (sortSpec) {
          const [[key, direction]] = Object.entries(sortSpec);
          result = [...result].sort((a, b) => compare(get(a, key), get(b, key)) * direction);
        }
        if (limit !== null) result = result.slice(0, limit);
        return result.map((item) => structuredClone(item));
      }
      return result ? structuredClone(result) : null;
    };
    const chain = {
      sort: (spec) => ((sortSpec = spec), chain),
      limit: (count) => ((limit = count), chain),
      select: () => chain,
      lean: async () => finish(),
    };
    return chain;
  };
  const model = {
    docs,
    findOne: (filter) => query(() => docs.find((doc) => matches(doc, filter)) || null),
    find: (filter) => query(() => docs.filter((doc) => matches(doc, filter))),
    countDocuments: async (filter) => docs.filter((doc) => matches(doc, filter)).length,
    create: async (input) => {
      const doc = { _id: `id-${(sequence += 1)}`, ...structuredClone(input) };
      for (const fields of unique) {
        if (docs.some((other) => fields.every((field) => same(get(other, field), get(doc, field))))) {
          throw Object.assign(new Error("duplicate key"), { code: 11000 });
        }
      }
      docs.push(doc);
      return structuredClone(doc);
    },
    insertMany: async (list) => Promise.all(list.map((item) => model.create(item))),
    updateOne: async (filter, update) => {
      const doc = docs.find((item) => matches(item, filter));
      if (doc) applyUpdate(doc, update);
      return { matchedCount: doc ? 1 : 0 };
    },
    findOneAndUpdate: (filter, update, options = {}) =>
      query(() => {
        let doc = docs.find((item) => matches(item, filter));
        if (!doc && options.upsert) {
          doc = { _id: `id-${(sequence += 1)}`, ...structuredClone(filter) };
          docs.push(doc);
        }
        if (doc) applyUpdate(doc, update);
        return doc || null;
      }),
    deleteMany: async (filter) => {
      for (let index = docs.length - 1; index >= 0; index -= 1) if (matches(docs[index], filter)) docs.splice(index, 1);
    },
  };
  return model;
};

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-27T06:00:00.000Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY).toISOString();

const setup = (modelReply = null) => {
  const models = {
    RecoveryProfile: makeModel({ unique: [["user"]] }),
    RecoveryCheckIn: makeModel({ unique: [["user", "day"]] }),
    RecoveryCraving: makeModel({ unique: [["user", "clientId"]] }),
    RecoveryLapse: makeModel(),
    RecoveryChatMessage: makeModel(),
  };
  const aiCalls = [];
  const ai = createRecoveryAi({
    callModel: async (options) => {
      aiCalls.push(options);
      return typeof modelReply === "function" ? modelReply(options) : modelReply;
    },
  });
  const controller = createRecoveryController({ models, ai, clock: () => new Date(NOW) });
  const call = async (handler, { body = {}, query = {}, user = "user-1" } = {}) => {
    const res = response();
    await controller[handler]({ body, query, profile: { _id: user } }, res);
    return res;
  };
  return { models, call, aiCalls };
};

const onboardingBody = {
  substances: [
    { key: "yaba", approach: "taper", quitDate: daysAgo(10), amountPerDay: 2, costPerUnit: 300, primary: true },
    { key: "cigarette", approach: "date", quitDate: daysAgo(-3), amountPerDay: 10, costPerUnit: 15 },
    { key: "alcohol", approach: "now", quitDate: daysAgo(1), amountPerDay: 2 },
  ],
  screenerAnswers: { yaba: [3, 3, 3, 3, 3] },
  readiness: { importance: 9, confidence: 4 },
  reasonKeys: ["family", "not-a-reason"],
  reasons: "For my mother",
  triggers: ["friends", "late_night"],
  supportContacts: [{ name: "Rahim", phone: "01700-000000", relation: "brother" }],
  timezone: "Asia/Dhaka",
  language: "bn",
  onboardingCompleted: true,
};

test("onboarding validates approaches, scores screeners and encrypts private text", async () => {
  const { models, call } = setup();
  const res = await call("saveProfile", { body: onboardingBody });
  assert.equal(res.statusCode, 200);
  const profile = res.body.profile;
  const [yaba, cigarette, alcohol] = profile.substances;
  assert.equal(yaba.approach, "now", "yaba cannot be tapered");
  assert.equal(yaba.screener.severity, "high");
  assert.equal(cigarette.approach, "date");
  assert.equal(alcohol.approach, "doctor", "alcohol always needs a doctor");
  assert.deepEqual(profile.reasonKeys, ["family"]);
  assert.equal(profile.reasons, "For my mother");
  assert.deepEqual(profile.supportContacts, [{ name: "Rahim", phone: "01700-000000", relation: "brother" }]);

  const stored = models.RecoveryProfile.docs[0];
  assert.match(stored.reasonsEnc, /^v[01]:/);
  assert.equal(JSON.stringify(stored).includes("mother"), false);
  assert.equal(JSON.stringify(stored).includes("Rahim"), false);
});

test("dashboard computes clean time, savings, help reasons and grants badges once", async () => {
  const { call } = setup();
  await call("saveProfile", { body: onboardingBody });
  const first = await call("dashboard", { query: { lang: "en" } });
  const yaba = first.body.substances.find((item) => item.key === "yaba");
  assert.equal(yaba.currentStreakDays, 10);
  assert.equal(yaba.moneySaved, 6000);
  assert.equal(yaba.milestone.nextLabel, "2 weeks");
  assert.ok(yaba.health.next.text.length > 10);
  assert.equal(first.body.substances.find((item) => item.key === "cigarette").status, "preparing");
  assert.deepEqual(first.body.proHelp, ["severity", "medical"]);
  assert.deepEqual(first.body.newBadges.map((badge) => badge.key), ["clean_1", "clean_3", "clean_7"]);
  const second = await call("dashboard", { query: { lang: "bn" } });
  assert.deepEqual(second.body.newBadges, []);
  assert.equal(second.body.substances[0].name, "ইয়াবা");
});

test("SOS logs are idempotent and award points", async () => {
  const { call, models } = setup();
  await call("saveProfile", { body: onboardingBody });
  const body = { clientId: "sos-1", at: daysAgo(0.1), intensityStart: 8, intensityEnd: 3, tools: ["breathing", "bogus"], outcome: "resisted", trigger: "friends" };
  const first = await call("logCraving", { body });
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.pointsEarned, 30);
  assert.deepEqual(first.body.craving.tools, ["breathing"]);
  assert.deepEqual(first.body.newBadges.map((badge) => badge.key), ["cravings_1"]);
  const again = await call("logCraving", { body });
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.pointsEarned, 0);
  assert.equal(models.RecoveryCraving.docs.length, 1);
  assert.equal(models.RecoveryProfile.docs[0].points, 30);
});

test("a slip restarts the streak, keeps the longest and returns safety advice and a debrief", async () => {
  const debrief = { reflection: "You were honest.", chain: ["Tired", "Friend called"], lesson: "Plan evenings.", newIfThen: { trigger: "Friends", action: "If they call, I say no and go home." }, risk: "none" };
  const { call, models } = setup({ text: JSON.stringify(debrief) });
  await call("saveProfile", { body: onboardingBody });
  const res = await call("logLapse", { body: { substance: "yaba", at: daysAgo(1), amount: 1, trigger: "friends", context: "Rahim came over after work" }, query: { lang: "en" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.substance.currentStreakDays, 1);
  assert.equal(res.body.substance.longestStreakDays, 9);
  assert.equal(res.body.debrief.source, "gemini");
  assert.match(res.body.safety.text, /chest pain/);
  assert.deepEqual(res.body.newBadges.map((badge) => badge.key), ["honest_restart"]);
  assert.equal(JSON.stringify(models.RecoveryLapse.docs).includes("Rahim"), false);

  const beforeQuit = await call("logLapse", { body: { substance: "yaba", at: daysAgo(20) } });
  assert.equal(beforeQuit.statusCode, 400);
  const untracked = await call("logLapse", { body: { substance: "heroin" } });
  assert.equal(untracked.statusCode, 400);
});

test("check-ins record reported use as a slip and surface crises from notes", async () => {
  const { call, models } = setup();
  await call("saveProfile", { body: onboardingBody });
  const res = await call("saveCheckin", {
    body: { mood: 1, craving: 9, used: [{ substance: "yaba", amount: 1 }, { substance: "heroin", amount: 2 }], halt: ["tired", "sleepy"], note: "আমি আর বাঁচতে চাই না" },
    query: { lang: "en" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.lapsesCreated, ["yaba"]);
  assert.equal(res.body.pointsEarned, 10);
  assert.deepEqual(res.body.checkin.halt, ["tired"]);
  assert.equal(res.body.crisis.type, "suicide");
  assert.ok(res.body.crisis.helplines.some((line) => line.phone === "999"));
  assert.match(res.body.checkin.reflection, /honest/);
  assert.equal(models.RecoveryLapse.docs.length, 1);

  const again = await call("saveCheckin", { body: { mood: 3, craving: 4, used: [{ substance: "yaba", amount: 1 }] } });
  assert.equal(again.body.pointsEarned, 0);
  assert.deepEqual(again.body.lapsesCreated, [], "one slip per substance per day");
  assert.equal(models.RecoveryCheckIn.docs.length, 1);
});

test("coach overrides a calm model reply with the crisis response and stores encrypted turns", async () => {
  const { call, models, aiCalls } = setup({ text: JSON.stringify({ reply: "Tell me more.", risk: "none", riskType: "none", suggestedTool: "none" }) });
  await call("saveProfile", { body: onboardingBody });
  const res = await call("coach", { body: { message: "I want to kill myself", mode: "coach" }, query: { lang: "en" } });
  assert.equal(res.body.risk, "crisis");
  assert.equal(res.body.riskType, "suicide");
  assert.equal(res.body.suggestedTool, "help");
  assert.match(res.body.crisis.message, /999/);
  assert.match(aiCalls[0].system, /may be in crisis/);
  assert.equal(models.RecoveryChatMessage.docs.length, 2);
  assert.equal(JSON.stringify(models.RecoveryChatMessage.docs).includes("kill myself"), false);
  assert.ok(models.RecoveryProfile.docs[0].lastCrisisAt);

  const history = await call("coachHistory", { query: { lang: "en" } });
  assert.deepEqual(history.body.messages.map((message) => message.role), ["user", "coach"]);
  assert.equal(history.body.messages[1].crisis.type, "suicide");
});

test("coach respects the AI switch and needs a profile", async () => {
  const { call } = setup();
  assert.equal((await call("coach", { body: { message: "hi" } })).statusCode, 404);
  await call("saveProfile", { body: { ...onboardingBody, settings: { aiEnabled: false } } });
  const res = await call("coach", { body: { message: "hi" } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "AI_DISABLED");
});

test("plan generation falls back to a curated plan and edits keep the safety note", async () => {
  const { call } = setup(null);
  await call("saveProfile", { body: onboardingBody });
  const generated = await call("generatePlan", { query: { lang: "en" } });
  assert.equal(generated.body.plan.source, "curated");
  assert.equal(generated.body.pointsEarned, 10);
  assert.match(generated.body.plan.safetyNote, /Never quit abruptly without a doctor/);
  const edited = await call("updatePlan", { body: { plan: { ...generated.body.plan, safetyNote: "no safety", rewardGoal: { title: "New phone", amount: 15000 } } } });
  assert.equal(edited.body.plan.safetyNote, generated.body.plan.safetyNote);
  assert.deepEqual(edited.body.plan.rewardGoal, { title: "New phone", amount: 15000 });
});

test("export returns decrypted data and reset deletes everything", async () => {
  const { call, models } = setup();
  await call("saveProfile", { body: onboardingBody });
  await call("logCraving", { body: { clientId: "x", intensityStart: 5, outcome: "resisted" } });
  await call("coach", { body: { message: "hello" } });
  const exported = await call("exportData");
  assert.equal(exported.body.profile.reasons, "For my mother");
  assert.equal(exported.body.cravings.length, 1);
  assert.equal(exported.body.coachMessages[0].text, "hello");
  await call("reset");
  assert.equal(Object.values(models).reduce((sum, model) => sum + model.docs.length, 0), 0);
  const after = await call("dashboard");
  assert.equal(after.body.profile, null);
});

test("profile input rejects bad quit dates and duplicate substances", () => {
  const now = new Date(NOW);
  assert.match(normalizeProfileInput({ substances: [{ key: "ganja", quitDate: new Date(NOW.getTime() + 40 * DAY) }] }, null, now).errors[0], /30 days/);
  assert.match(normalizeProfileInput({ substances: [{ key: "ganja" }, { key: "ganja" }] }, null, now).errors[0], /only be added once/);
  assert.match(normalizeProfileInput({ substances: [] }, null, now).errors[0], /between 1 and 6/);
  const ok = normalizeProfileInput({ substances: [{ key: "ganja", quitDate: new Date(NOW.getTime() + 60 * 1000) }] }, null, now);
  assert.equal(ok.update.substances[0].quitDate.getTime(), NOW.getTime(), "a few seconds of clock skew counts as now");
  assert.equal(ok.update.substances[0].primary, true);
});

test("content is served in the requested language", async () => {
  const { call } = setup();
  const res = await call("getContent", { query: { lang: "bn" } });
  assert.equal(res.body.lang, "bn");
  assert.equal(res.body.substances.find((item) => item.key === "ganja").name, "গাঁজা");
  assert.equal(typeof res.body.screeners.FTND.questions[0].options[0], "string");
  assert.ok(res.body.helplines.find((line) => line.key === "kaan_pete_roi").hours.includes("৩টা"));
});
