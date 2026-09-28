const assert = require("node:assert/strict");
const test = require("node:test");
const calc = require("./recoveryCalculations");

const DAY = calc.DAY_MS;
const NOW = new Date("2026-09-27T06:00:00.000Z"); // 12:00 in Dhaka
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY);
const TZ = "Asia/Dhaka";

const cigarettes = (overrides = {}) => ({
  key: "cigarette",
  amountPerDay: 10,
  daysPerWeek: 7,
  costPerUnit: 15,
  quitDate: daysAgo(10),
  streakStart: daysAgo(10),
  longestStreakDays: 0,
  bankedCleanDays: 0,
  ...overrides,
});

test("counts clean time, money, units and milestone progress", () => {
  const stats = calc.substanceStats(cigarettes(), { now: NOW, timezone: TZ });
  assert.equal(stats.status, "clean");
  assert.equal(stats.currentStreakDays, 10);
  assert.equal(stats.longestStreakDays, 10);
  assert.equal(stats.totalCleanDays, 10);
  assert.equal(stats.unitsAvoided, 100);
  assert.equal(stats.moneySaved, 1500);
  assert.equal(stats.lifeRegainedMinutes, 2000);
  assert.equal(stats.milestone.reachedDays, 7);
  assert.equal(stats.milestone.nextDays, 14);
  assert.ok(Math.abs(stats.milestone.progress - 3 / 7) < 1e-9);
  assert.ok(stats.health.reachedIndex >= 3);
});

test("a future quit date is 'preparing' with nothing counted yet", () => {
  const stats = calc.substanceStats(cigarettes({ quitDate: new Date(NOW.getTime() + 2 * DAY), streakStart: new Date(NOW.getTime() + 2 * DAY) }), { now: NOW, timezone: TZ });
  assert.equal(stats.status, "preparing");
  assert.equal(stats.msUntilQuit, 2 * DAY);
  assert.equal(stats.currentStreakMs, 0);
  assert.equal(stats.moneySaved, 0);
});

test("a slip restarts the current streak but keeps longest and total clean days", () => {
  const substance = cigarettes();
  const lapseAt = daysAgo(3);
  const lapseDayKeys = [calc.dayKey(lapseAt, TZ)];
  const update = calc.applyLapse(substance, lapseAt, { now: NOW, timezone: TZ, lapseDayKeys });
  assert.equal(update.longestStreakDays, 7);
  assert.equal(update.streakStart.getTime(), lapseAt.getTime());
  const stats = calc.substanceStats({ ...substance, ...update }, { now: NOW, timezone: TZ, lapseDayKeys });
  assert.equal(stats.currentStreakDays, 3);
  assert.equal(stats.longestStreakDays, 7);
  assert.equal(stats.totalCleanDays, 9);
});

test("an older, late-logged slip never lengthens the current streak", () => {
  const substance = cigarettes({ streakStart: daysAgo(2), longestStreakDays: 8 });
  const update = calc.applyLapse(substance, daysAgo(5), { now: NOW, timezone: TZ });
  assert.equal(update.streakStart.getTime(), daysAgo(2).getTime());
  assert.equal(update.longestStreakDays, 8);
});

test("choosing a new quit date banks the clean days already earned", () => {
  const substance = cigarettes();
  const lapseAt = daysAgo(0.5);
  const lapseDayKeys = [calc.dayKey(lapseAt, TZ)];
  const newQuitDate = new Date(NOW.getTime() + DAY);
  const update = calc.applyLapse(substance, lapseAt, { restart: "new_date", newQuitDate, now: NOW, timezone: TZ, lapseDayKeys });
  assert.equal(update.bankedCleanDays, 8);
  const stats = calc.substanceStats({ ...substance, ...update }, { now: NOW, timezone: TZ, lapseDayKeys });
  assert.equal(stats.status, "preparing");
  assert.equal(stats.totalCleanDays, 8);
  assert.equal(stats.longestStreakDays, 9);
});

test("day and week keys follow the user's timezone", () => {
  assert.equal(calc.dayKey(new Date("2026-09-26T18:30:00.000Z"), TZ), "2026-09-27");
  assert.equal(calc.dayKey(new Date("2026-09-26T17:59:00.000Z"), TZ), "2026-09-26");
  assert.equal(calc.localHour(new Date("2026-09-26T17:59:00.000Z"), TZ), 23);
  assert.equal(calc.weekKey(NOW, TZ), "2026-W39");
  assert.equal(calc.weekKey(new Date("2027-01-01T06:00:00.000Z"), TZ), "2026-W53");
  assert.equal(calc.safeTimezone("Not/AZone"), "Asia/Dhaka");
  assert.equal(calc.addDaysToKey("2026-03-01", -1), "2026-02-28");
});

test("scores screeners from option indexes", () => {
  assert.deepEqual(calc.scoreScreener("FTND", [0, 0, 0, 1, 0, 0], "cigarette"), { tool: "FTND", score: 8, severity: "high" });
  assert.deepEqual(calc.scoreScreener("FTND", [3, 1, 1, 0, 1, 1], "cigarette"), { tool: "FTND", score: 0, severity: "low" });
  assert.equal(calc.scoreScreener("SDS", [1, 1, 1, 1, 1], "yaba").severity, "moderate");
  assert.equal(calc.scoreScreener("SDS", [3, 3, 3, 3, 3], "yaba").severity, "high");
  assert.equal(calc.scoreScreener("SDS", [0, 1, 0, 1, 0], "yaba").severity, "low");
  assert.equal(calc.scoreScreener("CUDIT-R", [4, 2, 2, 1, 1, 1, 0, 2], "ganja").severity, "high");
  assert.equal(calc.scoreScreener("AUDIT-C", [2, 1, 1], "alcohol").severity, "moderate");
  assert.equal(calc.scoreScreener("FTND", [0, 0], "cigarette"), null);
  assert.equal(calc.scoreScreener("FTND", [9, 0, 0, 0, 0, 0], "cigarette"), null);
  assert.equal(calc.scoreScreener("NOPE", [], "cigarette"), null);
});

test("ranks SOS tools by what has worked for this person", () => {
  const cravings = [
    { tools: ["breathing"], outcome: "resisted" },
    { tools: ["breathing", "reasons"], outcome: "resisted" },
    { tools: ["breathing"], outcome: "resisted" },
    { tools: ["urge_surf"], outcome: "used" },
    { tools: ["urge_surf"], outcome: "used" },
  ];
  const order = calc.rankTools(cravings);
  assert.equal(order[0], "breathing");
  assert.equal(order[1], "reasons");
  assert.equal(order[order.length - 1], "urge_surf");
  assert.deepEqual(calc.rankTools([]), calc.DEFAULT_TOOL_ORDER);
});

test("finds the hours when cravings cluster", () => {
  const at = (hour, day = 0) => new Date(Date.UTC(2026, 8, 20 + day, hour - 6, 15));
  const cravings = [at(22), at(22, 1), at(22, 2), at(22, 3), at(15), at(15, 1), at(15, 2), at(9)].map((date) => ({ at: date }));
  assert.deepEqual(calc.riskHours(cravings, TZ), [22, 15]);
  assert.deepEqual(calc.riskHours(cravings.slice(0, 2), TZ), []);
});

test("check-in streak ends today or yesterday", () => {
  const keys = ["2026-09-25", "2026-09-26", "2026-09-27"];
  assert.equal(calc.checkinStreak(keys, "2026-09-27"), 3);
  assert.equal(calc.checkinStreak(keys, "2026-09-28"), 3);
  assert.equal(calc.checkinStreak(keys, "2026-09-30"), 0);
});

test("stage of change, badges and professional-help reasons", () => {
  assert.equal(calc.stageOfChange({ importance: 9, substances: [{ quitDate: daysAgo(200) }], now: NOW }), "maintenance");
  assert.equal(calc.stageOfChange({ importance: 9, substances: [{ quitDate: daysAgo(2) }], now: NOW }), "action");
  assert.equal(calc.stageOfChange({ importance: 8, substances: [{ quitDate: new Date(NOW.getTime() + 5 * DAY) }], now: NOW }), "preparation");
  assert.equal(calc.stageOfChange({ importance: 5, substances: [], now: NOW }), "contemplation");

  const badges = calc.earnedBadgeKeys({ longestStreakDays: 8, cravingsResisted: 12, checkinCount: 7 });
  assert.deepEqual(badges, ["clean_1", "clean_3", "clean_7", "cravings_1", "cravings_10", "checkins_7"]);

  assert.deepEqual(calc.professionalHelpReasons({ substances: [{ key: "heroin" }], now: NOW }), ["medical"]);
  assert.deepEqual(
    calc.professionalHelpReasons({ substances: [{ key: "yaba", screener: { severity: "high" } }], lastCrisisAt: daysAgo(2), lapsesLast30: 3, now: NOW }),
    ["severity", "crisis", "lapses"],
  );
  assert.deepEqual(calc.professionalHelpReasons({ substances: [{ key: "ganja" }], lastCrisisAt: daysAgo(30), now: NOW }), []);
});

test("summarises the last seven days", () => {
  const summary = calc.recentStats({
    checkins: [{ mood: 2, craving: 8 }, { mood: 4, craving: 3 }],
    cravings: [{ outcome: "resisted" }, { outcome: "used" }, { outcome: "resisted" }],
  });
  assert.deepEqual(summary, { checkins: 2, avgMood: 3, avgCraving: 5.5, cravingsLogged: 3, cravingsResisted: 2 });
});

test("background adds urgent professional-help reasons and curated safety notes", () => {
  const background = { physicalHealth: ["pregnant", "heart"], pastWithdrawal: ["hallucinations"], ageGroup: "under18", living: ["alone"] };
  assert.deepEqual(calc.professionalHelpReasons({ substances: [{ key: "yaba" }], background, now: NOW }), ["pregnancy", "withdrawal_history", "youth"]);
  assert.deepEqual(calc.backgroundSafetyKeys(background, [{ key: "yaba" }, { key: "heroin" }]), ["pregnant", "seizure_history", "heart", "alone_opioid", "under18"]);
  assert.deepEqual(calc.backgroundSafetyKeys(null, [{ key: "tramadol" }]), []);
  assert.deepEqual(calc.backgroundSafetyKeys({}, [{ key: "injection" }]), ["inject"]);
});
