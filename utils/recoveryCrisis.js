// Deterministic crisis detection for Recovery text (coach messages, check-in
// notes, slip notes). Runs before any AI call so a crisis always gets the curated
// safety response even when Gemini is slow, blocked or turned off.
// Bangla has no ASCII word boundaries, so Bangla phrases are matched as
// NFC-normalised substrings (with look-aheads for trailing negation "না").

const nfc = (value) => (typeof value === "string" ? value.normalize("NFC") : value);
const prepare = (list) => list.map((pattern) => (typeof pattern === "string" ? nfc(pattern) : new RegExp(nfc(pattern.source), pattern.flags)));

const RISK_LEVELS = ["none", "elevated", "crisis"];
const RISK_TYPES = ["none", "suicide", "overdose", "medical", "psychosis", "violence", "distress"];

// Ordered by priority: the first matching rule decides the crisis type.
const CRISIS_RULES = [
  {
    type: "suicide",
    patterns: prepare([
      /\b(kill(ing)? my ?self|suicid(e|al)|end(ing)? my life|end it all|take my (own )?life|(want|wanna|plan|planning) to die|wish i (was|were) dead|better off dead|no reason to live|don'?t want to (live|be alive|wake up)|self[- ]?harm|cut(ting)? myself|hang(ing)? myself)\b/i,
      /\b(atmohotta|attohotta|atmahatya|morte chai(?! ?na)|more jete chai(?! ?na)|bachte chai ?na|ar bachbo na|nijeke shesh kore|nijer khoti korbo|golay dori)\b/i,
      "আত্মহত্যা",
      "আত্মহনন",
      /মরে যেতে চাই(?!\s*না)/,
      /মরতে চাই(?!\s*না)/,
      "বাঁচতে চাই না",
      "বাচতে চাই না",
      "আর বাঁচব না",
      "আর বাঁচবো না",
      "বেঁচে থেকে লাভ নেই",
      "বেচে থেকে লাভ নেই",
      "নিজেকে শেষ করে",
      "নিজেকে মেরে ফেল",
      "গলায় দড়ি",
      "নিজের ক্ষতি করব",
      "নিজের ক্ষতি করবো",
      "হাত কাটব",
      "হাত কাটবো",
    ]),
  },
  {
    type: "overdose",
    patterns: prepare([
      /\b(overdos(e|ed|ing)|o\.?d'?d|took (way )?too (many|much)|too many pills|swallowed (all|a bunch|the whole)|poison(ed|ing)? myself|drank poison)\b/i,
      /\b(beshi kheye felechi|onek(gula)? (pill|tablet|bori) kheye|bish kheyechi|bish khabo)\b/i,
      "ওভারডোজ",
      "অনেক বেশি খেয়ে ফেলেছি",
      "বেশি খেয়ে ফেলেছি",
      "অনেকগুলো বড়ি",
      "অনেকগুলো ট্যাবলেট",
      "বিষ খেয়েছি",
      "বিষ খাব",
      "বিষ খাবো",
    ]),
  },
  {
    type: "medical",
    patterns: prepare([
      /\b(chest (pain|hurts|is tight)|can'?t breathe|cannot breathe|trouble breathing|hard to breathe|seizures?|having a fit|had a fit|convuls\w*|fainted|passed out|unconscious|won'?t wake up|not waking up|not breathing|blue lips|lips (are|turned) blue|(very|really) high (fever|temperature)|burning up|overheating)\b/i,
      /\b(buke (betha|byatha|batha)|buk (betha|byatha)|shash nite (parchi na|kosto)|shas nite (parchi na|kosto)|khichuni|oggyan|ogyan|hush nei|jhan nei)\b/i,
      "বুকে ব্যথা",
      "বুক ব্যথা",
      "বুকে চাপ",
      "শ্বাস নিতে পারছি না",
      "শ্বাস নিতে কষ্ট",
      "শ্বাসকষ্ট হচ্ছে",
      "দম বন্ধ হয়ে",
      "খিঁচুনি",
      "খিচুনি",
      "অজ্ঞান",
      "জ্ঞান নেই",
      "হুঁশ নেই",
      "হুশ নেই",
      "ঠোঁট নীল",
      "শরীর খুব গরম",
    ]),
  },
  {
    type: "psychosis",
    patterns: prepare([
      /\b(hearing voices|voices (are )?(telling|talking)|someone (is|was) (coming|trying) to kill me|(they|people) (are|were) (after|following|watching) me|seeing things that (are not|aren'?t) there|hallucinat\w*|bugs (under|crawling on) my skin)\b/i,
      /\b(keu amake marte|kane kotha shunchi|gayebi awaj|amake follow korche)\b/i,
      "কেউ আমাকে মারতে",
      "আমাকে মেরে ফেলবে",
      "কানে কথা শুনছি",
      "কানে কথা শুনি",
      "গায়েবি আওয়াজ",
      "আমাকে ফলো করছে",
      "সবাই আমার পিছনে লেগেছে",
    ]),
  },
  {
    type: "violence",
    patterns: prepare([
      /\b(kill (him|her|them|someone|somebody|my (father|mother|dad|mom|wife|husband|brother|sister))|going to hurt (him|her|them|someone)|stab (him|her|them|someone))\b/i,
      /\b(khun korbo|mere felbo)\b/i,
      "খুন করব",
      "খুন করবো",
      "মেরে ফেলব",
      "মেরে ফেলবো",
    ]),
  },
];

// Distress that deserves extra care and a visible help link, but not the crisis card.
const ELEVATED_PATTERNS = prepare([
  /\b(hopeless|worthless|can'?t go on|can'?t take (it|this) anymore|give up on (life|everything)|nobody cares|no one cares|i hate myself|killing me|going to die|hurt(ing)? myself|heart (is )?(racing|pounding)|panic attack|so depressed)\b/i,
  /\b(kichui bhalo lage na|hotash|ami okejo|moira jabo|more jabo|ar parchi na)\b/i,
  "হতাশ",
  "কিছুই ভালো লাগে না",
  "আমি অকেজো",
  "আমি অপদার্থ",
  "কেউ আমাকে ভালোবাসে না",
  "নিজেকে ঘৃণা",
  "আর পারছি না",
  "মরে যাব",
  "মরে যাবো",
  "নিজের ক্ষতি করছি",
  "বুক ধড়ফড়",
]);

// Negated statements ("I don't want to die", "not suicidal") are removed first.
const NEGATED = [
  /\b(don'?t|do not|never|not|no longer) (want|wanna|going|plan|planning) to (die|kill myself|end my life)\b/gi,
  /\b(not|no longer|never been) suicidal\b/gi,
];

const normalize = (text) => {
  let value = nfc(String(text || "")).toLowerCase().replace(/\s+/g, " ");
  NEGATED.forEach((pattern) => {
    value = value.replace(pattern, " ");
  });
  return value;
};

const matches = (text, patterns) =>
  patterns.some((pattern) => (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)));

/** @returns {{ level: 'none'|'elevated'|'crisis', type: string }} */
const detectCrisis = (...texts) => {
  const text = normalize(texts.filter(Boolean).join(" \n "));
  if (!text.trim()) return { level: "none", type: "none" };
  for (const rule of CRISIS_RULES) {
    if (matches(text, rule.patterns)) return { level: "crisis", type: rule.type };
  }
  if (matches(text, ELEVATED_PATTERNS)) return { level: "elevated", type: "distress" };
  return { level: "none", type: "none" };
};

const levelRank = (level) => Math.max(0, RISK_LEVELS.indexOf(level));

/** Combines two risk assessments, keeping the more serious one. */
const maxRisk = (a = {}, b = {}) => {
  const first = { level: RISK_LEVELS.includes(a.level) ? a.level : "none", type: RISK_TYPES.includes(a.type) ? a.type : "none" };
  const second = { level: RISK_LEVELS.includes(b.level) ? b.level : "none", type: RISK_TYPES.includes(b.type) ? b.type : "none" };
  if (levelRank(second.level) > levelRank(first.level)) return second;
  if (levelRank(second.level) === levelRank(first.level) && first.type === "none") return second;
  return first;
};

// Output guard: model replies that read as instructions for obtaining, dosing,
// hiding or testing-around drug use are replaced with a curated refusal. A refusal
// that happens to match is harmless because it is replaced by another refusal.
const UNSAFE_REPLY_PATTERNS = [
  /\b(pass|beat|cheat|fool) (a|the|your) (drug|dope|urine) tests?\b/i,
  /\b(hide|mask|cover up|get rid of) the (smell|odou?r)\b/i,
  /\b(dealers?|suppliers?|sellers?)('s)? (number|contact|phone)\b/i,
  /\b(start with|you can take|try taking|take only|just take) (\d+(\.\d+)?|half|one|two|a quarter)( of)?( an?)? ?(mg|milligrams?|pills?|tablets?|grams?|g|tola|puffs?|hits?|bottles?)\b/i,
  /\b(safer|safest) way to (use|smoke|take|inject|snort)\b/i,
  /\b(where|how) (you can|to) (buy|order|score|cop) (yaba|ice|meth|ganja|weed|heroin|phensedyl|codeine)\b/i,
];

const isUnsafeReply = (text) => UNSAFE_REPLY_PATTERNS.some((pattern) => pattern.test(String(text || "")));

module.exports = { RISK_LEVELS, RISK_TYPES, detectCrisis, maxRisk, isUnsafeReply };
