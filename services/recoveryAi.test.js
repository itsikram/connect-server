const assert = require("node:assert/strict");
const test = require("node:test");
const { createRecoveryAi, buildContext, curatedPlan } = require("./recoveryAi");
const { COACH_FALLBACKS, DAILY_NOTES, localize } = require("../utils/recoveryContent");

const stub = (response) => {
  const calls = [];
  const callModel = async (options) => {
    calls.push(options);
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response(options) : response;
  };
  return { ai: createRecoveryAi({ callModel }), calls };
};

const context = {
  substances: [{ key: "yaba", name: "Yaba", primary: true, safetyClass: "stimulant", daysClean: 4 }],
  triggerKeys: ["friends", "late_night"],
};

test("coach reply returns sanitised JSON from the model", async () => {
  const { ai, calls } = stub({ text: JSON.stringify({ reply: "Let's breathe together.", risk: "elevated", riskType: "distress", suggestedTool: "breathing" }), finishReason: "STOP" });
  const result = await ai.coachReply({
    message: "খুব ইচ্ছে করছে",
    mode: "sos",
    history: [{ role: "user", text: "hi" }, { role: "coach", text: "hello" }],
    context,
    lang: "bn",
  });
  assert.deepEqual(result, { reply: "Let's breathe together.", risk: "elevated", riskType: "distress", suggestedTool: "breathing", source: "gemini", status: "ok" });
  assert.equal(calls[0].json, true);
  assert.equal(calls[0].temperature, 0.4);
  assert.match(calls[0].system, /default to Bangla/);
  assert.match(calls[0].system, /RIGHT NOW/);
  assert.match(calls[0].system, /"daysClean":4/);
  assert.deepEqual(calls[0].messages.map((message) => message.role), ["user", "assistant", "user"]);
});

test("coach falls back when AI is off, failing or blocked", async () => {
  const off = await stub(null).ai.coachReply({ message: "hello", lang: "bn" });
  assert.equal(off.source, "fallback");
  assert.equal(off.reply, localize(COACH_FALLBACKS.coach, "bn"));

  const timeout = Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
  const slow = await stub(timeout).ai.coachReply({ message: "hello", mode: "sos" });
  assert.equal(slow.status, "timeout");
  assert.equal(slow.suggestedTool, "breathing");
  assert.equal(slow.reply, localize(COACH_FALLBACKS.sos, "en"));

  const blocked = await stub({ text: "", finishReason: "SAFETY" }).ai.coachReply({ message: "x" });
  assert.equal(blocked.reply, localize(COACH_FALLBACKS.refusal, "en"));
});

test("coach cleans invalid enums, salvages cut-off JSON and guards unsafe replies", async () => {
  const odd = await stub({ text: JSON.stringify({ reply: "ok", risk: "extreme", riskType: "x", suggestedTool: "teleport" }) }).ai.coachReply({ message: "hi" });
  assert.equal(odd.risk, "none");
  assert.equal(odd.riskType, "none");
  assert.equal(odd.suggestedTool, "none");

  const cut = await stub({ text: '{"reply": "Drink some water and\\nstep outside for', finishReason: "MAX_TOKENS" }).ai.coachReply({ message: "hi" });
  assert.equal(cut.reply, "Drink some water and\nstep outside for");

  const unsafe = await stub({ text: JSON.stringify({ reply: "To pass the drug test drink lots of water.", risk: "none", riskType: "none", suggestedTool: "none" }) }).ai.coachReply({ message: "help" });
  assert.equal(unsafe.reply, localize(COACH_FALLBACKS.refusal, "en"));
  assert.equal(unsafe.source, "fallback");
});

test("plan keeps curated safety text and valid tools only", async () => {
  const modelPlan = {
    summary: "Four weeks, one day at a time.",
    safetyNote: "model safety text that must be ignored",
    ifThen: [{ trigger: "Friends", action: "If friends offer, then I leave." }],
    tools: ["breathing", "teleport", "breathing"],
    checklist: ["Delete dealer numbers"],
    weeklyGoals: [{ week: 1, goal: "Check in daily", expect: "Crash days" }, { week: 9, goal: "Keep going" }],
    rewardIdea: "Buy a cricket bat",
  };
  const { ai } = stub({ text: JSON.stringify(modelPlan) });
  const plan = await ai.generatePlan({ context, lang: "en" });
  assert.equal(plan.source, "gemini");
  assert.notEqual(plan.safetyNote, "model safety text that must be ignored");
  assert.match(plan.safetyNote, /low mood after yaba/i);
  assert.deepEqual(plan.tools, ["breathing"]);
  assert.deepEqual(plan.checklist, [{ text: "Delete dealer numbers", done: false }]);
  assert.equal(plan.weeklyGoals[1].week, 4);
});

test("plan falls back to the curated plan on invalid or unsafe output", async () => {
  const invalid = await stub({ text: "not json" }).ai.generatePlan({ context, lang: "bn" });
  assert.equal(invalid.source, "curated");
  assert.equal(invalid.ifThen.length, 2);
  assert.ok(invalid.checklist.some((item) => item.text.includes("৩ দিনের")));

  const unsafe = await stub({ text: JSON.stringify({ summary: "x", ifThen: [{ trigger: "t", action: "Start with half a pill" }], checklist: ["a"], weeklyGoals: [{ week: 1, goal: "g" }] }) }).ai.generatePlan({ context });
  assert.equal(unsafe.source, "curated");
});

test("curated fallbacks for check-in, slip debrief and daily note", async () => {
  const { ai } = stub(null);
  const used = await ai.checkinReflection({ checkin: { used: [{ substance: "yaba", amount: 1 }], mood: 3 }, lang: "en" });
  assert.match(used.reflection, /honest/);
  const low = await ai.checkinReflection({ checkin: { mood: 1, craving: 2 }, lang: "en" });
  assert.match(low.reflection, /Low days/);

  const debrief = await ai.lapseDebrief({ lapse: { substance: "ganja", trigger: "friends" }, lang: "en" });
  assert.equal(debrief.source, "curated");
  assert.match(debrief.newIfThen.action, /friends offer/);

  const note = await ai.dailyNote({ lang: "en", dayIndex: DAILY_NOTES.length + 1 });
  assert.equal(note.note, localize(DAILY_NOTES[1].note, "en"));
});

test("conversation summary keeps the previous summary when AI fails", async () => {
  const { ai } = stub(new Error("boom"));
  assert.equal(await ai.summarizeConversation({ previousSummary: "old", turns: [{ role: "user", text: "hi" }] }), "old");
  const ok = stub({ text: "Struggles at night; breathing helps." });
  assert.equal(await ok.ai.summarizeConversation({ previousSummary: "", turns: [{ role: "user", text: "hi" }] }), "Struggles at night; breathing helps.");
});

test("AI context carries recovery facts but no contact details", () => {
  const now = new Date("2026-09-27T16:00:00.000Z");
  const built = buildContext({
    profile: {
      substances: [{ key: "phensedyl", primary: true, approach: "doctor", screener: { severity: "high" } }],
      triggers: ["stress"],
      reasonKeys: ["family"],
      reasonsText: "For my daughter",
      readiness: { importance: 9, confidence: 4 },
      supportContacts: [{ name: "Rahim Bhai", phone: "01700000000" }],
    },
    statsByKey: { phensedyl: { status: "clean", currentStreakDays: 12, longestStreakDays: 12, totalCleanDays: 12 } },
    lastLapse: { at: new Date("2026-09-20T10:00:00.000Z"), substance: "phensedyl", trigger: "stress" },
    toolOrder: ["breathing", "reasons", "call_support", "coach"],
    stage: "action",
    now,
    timezone: "Asia/Dhaka",
  });
  const serialized = JSON.stringify(built);
  assert.equal(serialized.includes("Rahim"), false);
  assert.equal(serialized.includes("01700000000"), false);
  assert.equal(built.hasSupportPerson, true);
  assert.equal(built.substances[0].safetyClass, "opioid");
  assert.equal(built.substances[0].dependence, "high");
  assert.match(built.safetyNotes[0], /overdose/);
  assert.deepEqual(built.reasons, ["My family", "For my daughter"]);
  assert.deepEqual(built.bestTools, ["breathing", "reasons", "call_support"]);
  assert.equal(built.lastLapse.daysAgo, 7);
  assert.equal(built.localTime, "Sun night");
});

test("curated plan always includes class-specific safety", () => {
  const plan = curatedPlan({ context: { substances: [{ safetyClass: "medical_taper", primary: true }] }, lang: "en" });
  assert.match(plan.safetyNote, /Never quit abruptly without a doctor/);
  assert.ok(plan.checklist.some((item) => /See a doctor before cutting down/.test(item.text)));
});
