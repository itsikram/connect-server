const assert = require("node:assert/strict");
const test = require("node:test");
const { detectCrisis, maxRisk, isUnsafeReply } = require("./recoveryCrisis");

const expectCrisis = (text, type) => {
  const result = detectCrisis(text);
  assert.equal(result.level, "crisis", `expected crisis for: ${text}`);
  assert.equal(result.type, type, `expected ${type} for: ${text}`);
};

test("detects suicidal statements in English, Banglish and Bangla", () => {
  expectCrisis("I want to kill myself tonight", "suicide");
  expectCrisis("honestly I just want to die", "suicide");
  expectCrisis("ami ar bachte chai na", "suicide");
  expectCrisis("আমি আর বাঁচতে চাই না", "suicide");
  expectCrisis("মাঝে মাঝে মনে হয় মরে যেতে চাই", "suicide");
  expectCrisis("আত্মহত্যার কথা ভাবছি", "suicide");
});

test("detects overdose and medical emergencies", () => {
  expectCrisis("I think I overdosed on yaba", "overdose");
  expectCrisis("অনেক বেশি খেয়ে ফেলেছি, মাথা ঘুরছে", "overdose");
  expectCrisis("yaba khawar por buke betha korche", "medical");
  expectCrisis("বুকে ব্যথা আর ঘাম হচ্ছে", "medical");
  expectCrisis("my friend passed out and won't wake up", "medical");
  expectCrisis("শ্বাস নিতে পারছি না", "medical");
});

test("detects psychosis and violence", () => {
  expectCrisis("I keep hearing voices telling me things", "psychosis");
  expectCrisis("কেউ আমাকে মারতে আসছে", "psychosis");
  expectCrisis("I'm going to hurt him when he gets home", "violence");
});

test("does not treat negated or figurative statements as a crisis", () => {
  assert.equal(detectCrisis("I don't want to die from smoking like my uncle").level, "none");
  assert.equal(detectCrisis("I'm not suicidal, just tired").level, "none");
  assert.equal(detectCrisis("আমি মরতে চাই না, বাঁচতে চাই").level, "none");
  assert.equal(detectCrisis("I'm dying for a cigarette after lunch").level, "none");
  assert.equal(detectCrisis("How do I handle cravings at the tea stall?").level, "none");
});

test("flags distress as elevated rather than crisis", () => {
  assert.deepEqual(detectCrisis("this craving is killing me"), { level: "elevated", type: "distress" });
  assert.deepEqual(detectCrisis("I know I'm hurting myself with yaba"), { level: "elevated", type: "distress" });
  assert.deepEqual(detectCrisis("কিছুই ভালো লাগে না"), { level: "elevated", type: "distress" });
  assert.deepEqual(detectCrisis("yaba khele moira jabo"), { level: "elevated", type: "distress" });
});

test("combines several texts and ignores empty input", () => {
  assert.equal(detectCrisis("", null, undefined).level, "none");
  assert.equal(detectCrisis("had a rough day", "I want to kill myself").type, "suicide");
});

test("maxRisk keeps the more serious assessment", () => {
  assert.deepEqual(maxRisk({ level: "none", type: "none" }, { level: "crisis", type: "overdose" }), { level: "crisis", type: "overdose" });
  assert.deepEqual(maxRisk({ level: "crisis", type: "suicide" }, { level: "elevated", type: "distress" }), { level: "crisis", type: "suicide" });
  assert.deepEqual(maxRisk({ level: "bogus" }, {}), { level: "none", type: "none" });
});

test("output guard catches instructions to obtain, dose or hide drug use", () => {
  assert.equal(isUnsafeReply("To pass the drug test, drink lots of water for three days."), true);
  assert.equal(isUnsafeReply("You can hide the smell with perfume and mint."), true);
  assert.equal(isUnsafeReply("Start with half a pill so the effect is lighter."), true);
  assert.equal(isUnsafeReply("Here is where you can buy yaba cheaply."), true);
  assert.equal(isUnsafeReply("Try 4-4-4-4 breathing and call your brother. Cravings pass."), false);
  assert.equal(isUnsafeReply("Avoid the places where dealers hang around and change your route home."), false);
  assert.equal(isUnsafeReply("Nicotine patches from a pharmacist can double your chances; ask a doctor which is right for you."), false);
});
