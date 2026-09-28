// Curated, bilingual (English / Bangla) content for the Recovery feature.
// Everything here is shown to people in a vulnerable moment: it must be reviewed
// by a clinician before launch. Helpline numbers were last checked in Sept 2026
// (kaanpeteroi.org, findahelpline.com/countries/bd, dghs.gov.bd) — re-verify
// before every release.

const L = (en, bn) => ({ en, bn });

const normalizeLang = (value) => (String(value || "").toLowerCase().startsWith("bn") ? "bn" : "en");

const isLocalized = (value) =>
  value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 2 && "en" in value && "bn" in value;

/** Deeply resolves every { en, bn } leaf to a single language. */
const localize = (value, lang = "en") => {
  const target = normalizeLang(lang);
  if (Array.isArray(value)) return value.map((item) => localize(item, target));
  if (isLocalized(value)) return value[target] || value.en;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localize(item, target)]));
  }
  return value;
};

/** Replaces {name} placeholders. */
const fill = (text, values = {}) => String(text || "").replace(/\{(\w+)\}/g, (match, key) => (values[key] !== undefined ? String(values[key]) : match));

// ---------------------------------------------------------------------------
// Safety classes: which quit approaches are safe, withdrawal expectations and
// the mandatory safety message for each group of substances.
// ---------------------------------------------------------------------------
const SAFETY_CLASSES = {
  nicotine: {
    approaches: ["now", "date", "taper"],
    defaultApproach: "date",
    title: L("Nicotine", "নিকোটিন"),
    quitAdvice: L(
      "You can stop on a set day or cut down first. Nicotine gum or patches from a doctor or pharmacist can greatly improve your chances.",
      "নির্দিষ্ট দিনে একেবারে ছাড়তে পারেন, অথবা আগে কমিয়ে নিতে পারেন। ডাক্তার বা ফার্মাসিস্টের পরামর্শে নিকোটিন গাম বা প্যাচ সফলতার সম্ভাবনা অনেক বাড়ায়।",
    ),
    withdrawal: L(
      "Irritability, restlessness, hunger and strong urges are common. They peak in the first 3 days and fade over 2–4 weeks.",
      "খিটখিটে মেজাজ, অস্থিরতা, খিদে আর তীব্র ইচ্ছে স্বাভাবিক। প্রথম ৩ দিনে সবচেয়ে বেশি থাকে, ২–৪ সপ্তাহে কমে যায়।",
    ),
    safety: L(
      "Stopping nicotine is safe. Withdrawal is uncomfortable but not dangerous.",
      "নিকোটিন ছাড়া নিরাপদ। উইথড্রয়াল অস্বস্তিকর, কিন্তু বিপজ্জনক নয়।",
    ),
    lapseSafety: L(
      "A single slip doesn't undo the healing your body has already done. Get back to your plan at the very next moment.",
      "একবার খেলে শরীরের এতদিনের সুস্থ হওয়া নষ্ট হয়ে যায় না। পরের মুহূর্ত থেকেই পরিকল্পনায় ফিরে আসুন।",
    ),
  },
  cannabis: {
    approaches: ["now", "date", "taper"],
    defaultApproach: "now",
    title: L("Cannabis", "গাঁজা"),
    quitAdvice: L(
      "Stopping is safe. You can stop now or cut down over 1–2 weeks. Plan for poor sleep in the first week.",
      "ছাড়া নিরাপদ। এখনই ছাড়তে পারেন বা ১–২ সপ্তাহে কমিয়ে ছাড়তে পারেন। প্রথম সপ্তাহে ঘুমের সমস্যার জন্য প্রস্তুত থাকুন।",
    ),
    withdrawal: L(
      "Irritability, poor sleep, vivid dreams and low appetite usually start in 1–3 days, peak around days 2–6 and mostly settle in 1–2 weeks.",
      "খিটখিটে মেজাজ, ঘুমের সমস্যা, স্পষ্ট স্বপ্ন আর খিদে কমে যাওয়া সাধারণত ১–৩ দিনে শুরু হয়, ২–৬ দিনে সবচেয়ে বেশি থাকে, ১–২ সপ্তাহে বেশিরভাগ কমে যায়।",
    ),
    safety: L(
      "Stopping ganja is safe. Withdrawal is unpleasant but not dangerous.",
      "গাঁজা ছাড়া নিরাপদ। উইথড্রয়াল অস্বস্তিকর, কিন্তু বিপজ্জনক নয়।",
    ),
    lapseSafety: L(
      "One slip doesn't wipe out your progress. Notice what led to it and get back to your plan.",
      "একবার খেলে অগ্রগতি মুছে যায় না। কী কারণে হলো খেয়াল করুন, তারপর পরিকল্পনায় ফিরে আসুন।",
    ),
  },
  stimulant: {
    approaches: ["now", "date"],
    defaultApproach: "now",
    title: L("Stimulant (yaba / ICE)", "উত্তেজক মাদক (ইয়াবা / আইস)"),
    quitAdvice: L(
      "Stop completely — cutting down rarely works with yaba. Expect a 'crash' for a few days: sleep, eat and drink water. If you feel hopeless or have thoughts of harming yourself, get help right away.",
      "একেবারে ছেড়ে দিন—ইয়াবা কমিয়ে কমিয়ে ছাড়া সাধারণত কাজ করে না। কয়েকদিন 'ক্র্যাশ' হবে: ঘুমান, খান, পানি খান। হতাশ লাগলে বা নিজের ক্ষতি করার চিন্তা এলে সাথে সাথে সাহায্য নিন।",
    ),
    withdrawal: L(
      "First 1–3 days: exhaustion, long sleep, hunger and low mood. Days 4–10: strong cravings, irritability and poor sleep. Mood and energy slowly improve over the following weeks.",
      "প্রথম ১–৩ দিন: প্রচণ্ড ক্লান্তি, অনেক ঘুম, খিদে আর মন খারাপ। ৪–১০ দিন: তীব্র ইচ্ছে, খিটখিটে মেজাজ, ঘুমের সমস্যা। পরের সপ্তাহগুলোতে মন আর শক্তি ধীরে ধীরে ভালো হয়।",
    ),
    safety: L(
      "Stopping is not dangerous in itself, but low mood after yaba can be severe. If you have thoughts of suicide, or you see or hear things others don't, get help immediately (999 or Kaan Pete Roi).",
      "ছাড়াটা নিজে বিপজ্জনক নয়, তবে ইয়াবার পর মন খুব খারাপ হতে পারে। আত্মহত্যার চিন্তা এলে, বা অন্যরা দেখে না এমন কিছু দেখলে/শুনলে সাথে সাথে সাহায্য নিন (৯৯৯ বা কান পেতে রই)।",
    ),
    lapseSafety: L(
      "Watch for danger signs: chest pain, a racing heart, very high body temperature, seizures, severe confusion, or feeling that people are after you. If any happen, call 999. Drink water, eat something and try to sleep.",
      "বিপদের লক্ষণ খেয়াল রাখুন: বুকে ব্যথা, বুক ধড়ফড়, শরীর খুব গরম হওয়া, খিঁচুনি, খুব বিভ্রান্তি, বা মনে হওয়া যে কেউ আপনার পিছু নিয়েছে। এমন হলে ৯৯৯-এ ফোন করুন। পানি খান, কিছু খান আর ঘুমানোর চেষ্টা করুন।",
    ),
  },
  opioid: {
    approaches: ["doctor", "now", "date"],
    defaultApproach: "doctor",
    title: L("Opioid (phensedyl / heroin)", "অপিয়য়েড (ফেনসিডিল / হেরোইন)"),
    quitAdvice: L(
      "Withdrawal is very uncomfortable, so get support from a doctor or a treatment centre — medicines can make it much easier and safer.",
      "উইথড্রয়াল খুব কষ্টের, তাই ডাক্তার বা চিকিৎসা কেন্দ্রের সহায়তা নিন—ওষুধে এটা অনেক সহজ ও নিরাপদ হয়।",
    ),
    withdrawal: L(
      "Aches, sweating, runny nose, stomach cramps, diarrhoea and poor sleep start within a day, peak around days 1–3 and ease over about a week. Cravings can last longer.",
      "শরীর ব্যথা, ঘাম, নাক দিয়ে পানি পড়া, পেট কামড়ানো, পাতলা পায়খানা আর ঘুমের সমস্যা এক দিনের মধ্যে শুরু হয়, ১–৩ দিনে সবচেয়ে বেশি থাকে, প্রায় এক সপ্তাহে কমে। ইচ্ছে আরও বেশিদিন থাকতে পারে।",
    ),
    safety: L(
      "After even a few days without use, your tolerance drops. Using your old amount can cause a fatal overdose. Never use alone.",
      "কয়েকদিন না খাওয়ার পরই শরীরের সহনশীলতা কমে যায়। আগের পরিমাণ নিলে প্রাণঘাতী ওভারডোজ হতে পারে। কখনো একা নেবেন না।",
    ),
    lapseSafety: L(
      "Important: after a break your tolerance is lower, so your old amount can cause an overdose. Never use alone. If someone is very sleepy, breathing slowly or has blue lips, call 999 and lay them on their side.",
      "জরুরি: বিরতির পর সহনশীলতা কমে যায়, তাই আগের পরিমাণে ওভারডোজ হতে পারে। কখনো একা নেবেন না। কেউ খুব ঝিমিয়ে পড়লে, ধীরে শ্বাস নিলে বা ঠোঁট নীল হলে ৯৯৯-এ ফোন করুন এবং তাকে এক পাশে কাত করে শুইয়ে দিন।",
    ),
  },
  medical_taper: {
    approaches: ["doctor"],
    defaultApproach: "doctor",
    title: L("Needs a doctor (alcohol / sedatives / pregabalin)", "ডাক্তার প্রয়োজন (মদ / ঘুমের ওষুধ / প্রিগাবালিন)"),
    quitAdvice: L(
      "Do not stop suddenly on your own. If you use every day, stopping abruptly can cause seizures. See a doctor first for a safe, slow reduction — the app will support you along the way.",
      "নিজে থেকে হঠাৎ বন্ধ করবেন না। প্রতিদিন নিলে হঠাৎ বন্ধ করায় খিঁচুনি হতে পারে। আগে ডাক্তার দেখান, নিরাপদে ধীরে কমানোর পরিকল্পনা করুন—পুরো পথে এই অ্যাপ পাশে থাকবে।",
    ),
    withdrawal: L(
      "Shaking, sweating, anxiety and poor sleep can start within a day. Seizures and confusion are possible in the first days, which is why medical supervision matters.",
      "কাঁপুনি, ঘাম, উদ্বেগ আর ঘুমের সমস্যা এক দিনের মধ্যে শুরু হতে পারে। প্রথম কয়েকদিনে খিঁচুনি ও বিভ্রান্তি হতে পারে—তাই ডাক্তারের তত্ত্বাবধান জরুরি।",
    ),
    safety: L(
      "Never quit abruptly without a doctor. Shaking, confusion, seeing things or seizures need urgent care — call 999.",
      "ডাক্তার ছাড়া কখনো হঠাৎ বন্ধ করবেন না। কাঁপুনি, বিভ্রান্তি, কিছু দেখা বা খিঁচুনি হলে জরুরি চিকিৎসা লাগবে—৯৯৯-এ ফোন করুন।",
    ),
    lapseSafety: L(
      "If you are using again, don't stop suddenly on your own — talk to a doctor about a safe plan. Shaking, sweating, confusion or seizures need urgent care (999).",
      "আবার শুরু হয়ে থাকলে নিজে থেকে হঠাৎ বন্ধ করবেন না—নিরাপদ পরিকল্পনার জন্য ডাক্তারের সাথে কথা বলুন। কাঁপুনি, ঘাম, বিভ্রান্তি বা খিঁচুনি হলে জরুরি চিকিৎসা নিন (৯৯৯)।",
    ),
  },
  inhalant: {
    approaches: ["now", "date"],
    defaultApproach: "now",
    title: L("Inhalant (dandy / glue)", "ইনহেল্যান্ট (ড্যান্ডি / গাম)"),
    quitAdvice: L(
      "Stop completely and stay with people who support you. Headaches, irritability and poor sleep in the first days are common.",
      "একেবারে ছেড়ে দিন আর যারা সাহায্য করে তাদের কাছাকাছি থাকুন। প্রথম কয়েকদিন মাথাব্যথা, খিটখিটে মেজাজ আর ঘুমের সমস্যা স্বাভাবিক।",
    ),
    withdrawal: L(
      "Headaches, irritability, poor sleep and cravings for the first days; mood and appetite improve over 1–2 weeks.",
      "প্রথম কয়েকদিন মাথাব্যথা, খিটখিটে মেজাজ, ঘুমের সমস্যা আর ইচ্ছে; ১–২ সপ্তাহে মন আর খিদে ভালো হয়।",
    ),
    safety: L(
      "Sniffing glue can cause sudden heart problems and fainting. Fainting, chest pain or trouble breathing need urgent help — call 999.",
      "গাম শুঁকলে হঠাৎ হৃদযন্ত্রের সমস্যা ও অজ্ঞান হওয়া হতে পারে। অজ্ঞান হওয়া, বুকে ব্যথা বা শ্বাসকষ্ট হলে সাথে সাথে সাহায্য নিন—৯৯৯-এ ফোন করুন।",
    ),
    lapseSafety: L(
      "If you feel faint, dizzy or your chest hurts, stop and get help right away — call 999.",
      "মাথা ঘোরা, অজ্ঞান ভাব বা বুকে ব্যথা হলে থামুন এবং সাথে সাথে সাহায্য নিন—৯৯৯-এ ফোন করুন।",
    ),
  },
  hallucinogen: {
    approaches: ["now", "date", "doctor"],
    defaultApproach: "now",
    title: L("Hallucinogen / ketamine", "হ্যালুসিনোজেন / কেটামিন"),
    quitAdvice: L(
      "Stopping is physically safe for most people. Plan for low mood, poor sleep and cravings in the first weeks, and avoid the people and parties linked to use.",
      "বেশিরভাগ মানুষের জন্য ছাড়া শারীরিকভাবে নিরাপদ। প্রথম কয়েক সপ্তাহে মন খারাপ, ঘুমের সমস্যা আর ইচ্ছের জন্য প্রস্তুত থাকুন, আর নেশার সাথে জড়িত মানুষ ও পার্টি এড়িয়ে চলুন।",
    ),
    withdrawal: L(
      "Low mood, anxiety, tiredness and poor sleep are common for 1–3 weeks. Some people have flashbacks or visual changes that fade with time.",
      "১–৩ সপ্তাহ মন খারাপ, উদ্বেগ, ক্লান্তি আর ঘুমের সমস্যা স্বাভাবিক। কারো কারো আগের অভিজ্ঞতা হঠাৎ ফিরে আসে বা চোখে অন্যরকম দেখে—সময়ের সাথে কমে যায়।",
    ),
    safety: L(
      "Stopping is not dangerous in itself. Ketamine can damage the bladder: pain or blood when passing urine needs a doctor. Panic, seeing things or not feeling real need medical help.",
      "ছাড়াটা নিজে বিপজ্জনক নয়। কেটামিন মূত্রথলির ক্ষতি করতে পারে: প্রস্রাবে ব্যথা বা রক্ত গেলে ডাক্তার দেখান। প্যানিক, কিছু দেখা বা নিজেকে অবাস্তব মনে হলে চিকিৎসা নিন।",
    ),
    lapseSafety: L(
      "Don't use alone and don't mix with alcohol or other drugs. If someone is unresponsive, very confused or panicking badly, call 999.",
      "একা নেবেন না, মদ বা অন্য মাদকের সাথে মেশাবেন না। কেউ সাড়া না দিলে, খুব বিভ্রান্ত হলে বা ভীষণ আতঙ্কিত হলে ৯৯৯-এ ফোন করুন।",
    ),
  },
  other: {
    approaches: ["doctor", "now", "date"],
    defaultApproach: "doctor",
    title: L("Other", "অন্যান্য"),
    quitAdvice: L(
      "Some substances are risky to stop suddenly. If you are unsure, check with a doctor before you stop.",
      "কিছু মাদক হঠাৎ বন্ধ করা ঝুঁকিপূর্ণ। নিশ্চিত না হলে বন্ধ করার আগে ডাক্তারের সাথে কথা বলুন।",
    ),
    withdrawal: L(
      "Withdrawal depends on the substance. Tell a doctor what you use and how much.",
      "উইথড্রয়াল নির্ভর করে কোন মাদক তার ওপর। কী আর কতটুকু নেন, ডাক্তারকে জানান।",
    ),
    safety: L(
      "If you feel very unwell after stopping, get medical help — call 999 in an emergency.",
      "ছাড়ার পর খুব অসুস্থ লাগলে চিকিৎসা নিন—জরুরি অবস্থায় ৯৯৯-এ ফোন করুন।",
    ),
    lapseSafety: L(
      "Use is riskier after a break. If you feel very unwell, call 999.",
      "বিরতির পর আবার নেওয়া বেশি ঝুঁকিপূর্ণ। খুব অসুস্থ লাগলে ৯৯৯-এ ফোন করুন।",
    ),
  },
};

// ---------------------------------------------------------------------------
// Substances (icons are MaterialCommunityIcons names used by the app).
// sdsCutoff: Severity of Dependence Scale score at which dependence is likely.
// ---------------------------------------------------------------------------
const SUBSTANCES = [
  { key: "yaba", safetyClass: "stimulant", screener: "SDS", sdsCutoff: 4, icon: "pill", name: L("Yaba", "ইয়াবা"), unit: L("pills", "বড়ি"), unitOne: L("pill", "বড়ি"), defaultAmount: 2 },
  { key: "ice", safetyClass: "stimulant", screener: "SDS", sdsCutoff: 4, icon: "diamond-stone", name: L("ICE / crystal meth", "আইস / ক্রিস্টাল মেথ"), unit: L("uses", "বার"), unitOne: L("use", "বার"), defaultAmount: 1 },
  { key: "ganja", safetyClass: "cannabis", screener: "CUDIT-R", sdsCutoff: 3, icon: "cannabis", name: L("Ganja / weed", "গাঁজা"), unit: L("joints", "স্টিক"), unitOne: L("joint", "স্টিক"), defaultAmount: 3 },
  { key: "cigarette", safetyClass: "nicotine", screener: "FTND", sdsCutoff: 3, icon: "smoking", name: L("Cigarette / bidi", "সিগারেট / বিড়ি"), unit: L("cigarettes", "সিগারেট"), unitOne: L("cigarette", "সিগারেট"), defaultAmount: 10, lifeMinutesPerUnit: 20 },
  { key: "smokeless", safetyClass: "nicotine", screener: "SDS", sdsCutoff: 3, icon: "leaf", name: L("Jorda / gul / sada pata", "জর্দা / গুল / সাদাপাতা"), unit: L("uses", "বার"), unitOne: L("use", "বার"), defaultAmount: 5 },
  { key: "phensedyl", safetyClass: "opioid", screener: "SDS", sdsCutoff: 5, icon: "bottle-tonic-outline", name: L("Phensedyl / codeine syrup", "ফেনসিডিল / কোডিন সিরাপ"), unit: L("bottles", "বোতল"), unitOne: L("bottle", "বোতল"), defaultAmount: 1 },
  { key: "heroin", safetyClass: "opioid", screener: "SDS", sdsCutoff: 5, icon: "flask-outline", name: L("Heroin", "হেরোইন"), unit: L("doses", "পুরিয়া"), unitOne: L("dose", "পুরিয়া"), defaultAmount: 2 },
  { key: "alcohol", safetyClass: "medical_taper", screener: "AUDIT-C", sdsCutoff: 3, icon: "glass-mug-variant", name: L("Alcohol", "মদ / অ্যালকোহল"), unit: L("drinks", "গ্লাস"), unitOne: L("drink", "গ্লাস"), defaultAmount: 3 },
  { key: "sleeping_pills", safetyClass: "medical_taper", screener: "SDS", sdsCutoff: 4, icon: "pill-multiple", name: L("Sleeping pills", "ঘুমের ওষুধ"), unit: L("pills", "বড়ি"), unitOne: L("pill", "বড়ি"), defaultAmount: 1 },
  { key: "inhalant", safetyClass: "inhalant", screener: "SDS", sdsCutoff: 3, icon: "spray", name: L("Dandy / glue", "ড্যান্ডি / গাম"), unit: L("uses", "বার"), unitOne: L("use", "বার"), defaultAmount: 3 },
  { key: "tramadol", safetyClass: "opioid", screener: "SDS", sdsCutoff: 5, icon: "pill", name: L("Tramadol / painkillers", "ট্রামাডল / ব্যথার ওষুধ"), unit: L("tablets", "ট্যাবলেট"), unitOne: L("tablet", "ট্যাবলেট"), defaultAmount: 2 },
  { key: "injection", safetyClass: "opioid", screener: "SDS", sdsCutoff: 5, icon: "needle", name: L("Injecting drugs (buprenorphine / pethidine)", "ইনজেকশনের মাদক (বুপ্রেনরফিন / পেথিডিন)"), unit: L("injections", "ইনজেকশন"), unitOne: L("injection", "ইনজেকশন"), defaultAmount: 2 },
  { key: "cocaine", safetyClass: "stimulant", screener: "SDS", sdsCutoff: 3, icon: "grain", name: L("Cocaine", "কোকেন"), unit: L("uses", "বার"), unitOne: L("use", "বার"), defaultAmount: 1 },
  { key: "mdma", safetyClass: "stimulant", screener: "SDS", sdsCutoff: 3, icon: "pill", name: L("Ecstasy / MDMA / party pills", "এক্সট্যাসি / এমডিএমএ / পার্টি পিল"), unit: L("pills", "বড়ি"), unitOne: L("pill", "বড়ি"), defaultAmount: 1 },
  { key: "vape", safetyClass: "nicotine", screener: "SDS", sdsCutoff: 3, icon: "smoke", name: L("Vape / e-cigarette", "ভেপ / ই-সিগারেট"), unit: L("sessions", "বার"), unitOne: L("session", "বার"), defaultAmount: 10 },
  { key: "pregabalin", safetyClass: "medical_taper", screener: "SDS", sdsCutoff: 4, icon: "pill-multiple", name: L("Pregabalin / gabapentin", "প্রিগাবালিন / গাবাপেন্টিন"), unit: L("capsules", "ক্যাপসুল"), unitOne: L("capsule", "ক্যাপসুল"), defaultAmount: 2 },
  { key: "ketamine", safetyClass: "hallucinogen", screener: "SDS", sdsCutoff: 3, icon: "flask-empty-outline", name: L("Ketamine", "কেটামিন"), unit: L("uses", "বার"), unitOne: L("use", "বার"), defaultAmount: 1 },
  { key: "lsd", safetyClass: "hallucinogen", screener: "SDS", sdsCutoff: 3, icon: "mushroom-outline", name: L("LSD / magic mushrooms", "এলএসডি / ম্যাজিক মাশরুম"), unit: L("uses", "বার"), unitOne: L("use", "বার"), defaultAmount: 1 },
  { key: "synthetic_cannabis", safetyClass: "other", screener: "SDS", sdsCutoff: 3, icon: "cannabis-off", name: L("Kush / K2 / synthetic weed", "কুশ / কে২ / সিনথেটিক গাঁজা"), unit: L("uses", "বার"), unitOne: L("use", "বার"), defaultAmount: 2 },
  { key: "other", safetyClass: "other", screener: "SDS", sdsCutoff: 4, icon: "help-circle-outline", name: L("Other", "অন্য কিছু"), unit: L("uses", "বার"), unitOne: L("use", "বার"), defaultAmount: 1 },
];

const SUBSTANCE_KEYS = SUBSTANCES.map((item) => item.key);
const substanceMeta = (key) => SUBSTANCES.find((item) => item.key === key) || SUBSTANCES[SUBSTANCES.length - 1];
const safetyClassOf = (key) => substanceMeta(key).safetyClass;

// ---------------------------------------------------------------------------
// Screeners (screening only — never presented as a diagnosis).
// FTND, CUDIT-R, SDS and AUDIT-C are free to use; the Bangla wording is a
// working translation to be checked against validated versions before launch.
// ---------------------------------------------------------------------------
const YES_NO = [
  { label: L("Yes", "হ্যাঁ"), score: 1 },
  { label: L("No", "না"), score: 0 },
];
const FREQUENCY_6M = [
  { label: L("Never", "কখনো না"), score: 0 },
  { label: L("Less than monthly", "মাসে একবারেরও কম"), score: 1 },
  { label: L("Monthly", "মাসে একবার"), score: 2 },
  { label: L("Weekly", "সপ্তাহে একবার"), score: 3 },
  { label: L("Daily or almost daily", "প্রায় প্রতিদিন"), score: 4 },
];
const USE_FREQUENCY = [
  { label: L("Never", "কখনো না"), score: 0 },
  { label: L("Monthly or less", "মাসে একবার বা কম"), score: 1 },
  { label: L("2–4 times a month", "মাসে ২–৪ বার"), score: 2 },
  { label: L("2–3 times a week", "সপ্তাহে ২–৩ বার"), score: 3 },
  { label: L("4 or more times a week", "সপ্তাহে ৪ বা তার বেশি বার"), score: 4 },
];
const SDS_OFTEN = [
  { label: L("Never or almost never", "কখনো না / প্রায় কখনো না"), score: 0 },
  { label: L("Sometimes", "মাঝে মাঝে"), score: 1 },
  { label: L("Often", "প্রায়ই"), score: 2 },
  { label: L("Always or nearly always", "সবসময় / প্রায় সবসময়"), score: 3 },
];

const SCREENERS = {
  FTND: {
    title: L("Nicotine dependence (Fagerström test)", "নিকোটিন নির্ভরতা (ফাগারস্ট্রম টেস্ট)"),
    thresholds: { moderate: 4, high: 7 },
    maxScore: 10,
    questions: [
      {
        text: L("How soon after you wake up do you smoke your first cigarette?", "ঘুম থেকে ওঠার কতক্ষণ পর প্রথম সিগারেট খান?"),
        options: [
          { label: L("Within 5 minutes", "৫ মিনিটের মধ্যে"), score: 3 },
          { label: L("6–30 minutes", "৬–৩০ মিনিট"), score: 2 },
          { label: L("31–60 minutes", "৩১–৬০ মিনিট"), score: 1 },
          { label: L("After 60 minutes", "৬০ মিনিটের পরে"), score: 0 },
        ],
      },
      {
        text: L("Is it hard not to smoke where it is forbidden (bus, hospital, office)?", "যেখানে ধূমপান নিষেধ (বাস, হাসপাতাল, অফিস), সেখানে না খেয়ে থাকা কি কঠিন লাগে?"),
        options: YES_NO,
      },
      {
        text: L("Which cigarette would you hate most to give up?", "কোন সিগারেটটা ছাড়তে সবচেয়ে কষ্ট হবে?"),
        options: [
          { label: L("The first one in the morning", "সকালের প্রথমটা"), score: 1 },
          { label: L("Any other", "অন্য যেকোনোটা"), score: 0 },
        ],
      },
      {
        text: L("How many cigarettes do you smoke per day?", "দিনে কয়টা সিগারেট খান?"),
        options: [
          { label: L("10 or fewer", "১০টা বা কম"), score: 0 },
          { label: L("11–20", "১১–২০টা"), score: 1 },
          { label: L("21–30", "২১–৩০টা"), score: 2 },
          { label: L("31 or more", "৩১টা বা বেশি"), score: 3 },
        ],
      },
      {
        text: L("Do you smoke more in the first hours after waking than during the rest of the day?", "ঘুম থেকে ওঠার পরের কয়েক ঘণ্টায় কি দিনের বাকি সময়ের চেয়ে বেশি খান?"),
        options: YES_NO,
      },
      {
        text: L("Do you smoke even when you are so ill that you stay in bed most of the day?", "এত অসুস্থ যে সারাদিন বিছানায় থাকতে হয়—তখনও কি সিগারেট খান?"),
        options: YES_NO,
      },
    ],
  },
  "CUDIT-R": {
    title: L("Cannabis use (CUDIT-R)", "গাঁজা ব্যবহার (CUDIT-R)"),
    thresholds: { moderate: 8, high: 12 },
    maxScore: 32,
    questions: [
      { text: L("How often do you use ganja?", "কত ঘন ঘন গাঁজা খান?"), options: USE_FREQUENCY },
      {
        text: L("On a typical day when you use, how many hours are you high?", "যেদিন খান, সাধারণত কত ঘণ্টা নেশায় থাকেন?"),
        options: [
          { label: L("Less than 1", "১ ঘণ্টার কম"), score: 0 },
          { label: L("1–2", "১–২ ঘণ্টা"), score: 1 },
          { label: L("3–4", "৩–৪ ঘণ্টা"), score: 2 },
          { label: L("5–6", "৫–৬ ঘণ্টা"), score: 3 },
          { label: L("7 or more", "৭ ঘণ্টা বা বেশি"), score: 4 },
        ],
      },
      { text: L("In the past 6 months, how often could you not stop once you had started?", "গত ৬ মাসে কতবার এমন হয়েছে যে শুরু করার পর থামতে পারেননি?"), options: FREQUENCY_6M },
      { text: L("In the past 6 months, how often did you fail to do what was expected of you because of ganja?", "গত ৬ মাসে গাঁজার কারণে কতবার নিজের দায়িত্ব (কাজ, পড়া, পরিবার) পালন করতে পারেননি?"), options: FREQUENCY_6M },
      { text: L("In the past 6 months, how often did getting, using or recovering from ganja take up a lot of your time?", "গত ৬ মাসে কতবার গাঁজা জোগাড় করা, খাওয়া বা নেশা কাটাতে অনেক সময় চলে গেছে?"), options: FREQUENCY_6M },
      { text: L("In the past 6 months, how often have you had problems with memory or concentration after using?", "গত ৬ মাসে খাওয়ার পর কতবার মনে রাখা বা মনোযোগে সমস্যা হয়েছে?"), options: FREQUENCY_6M },
      { text: L("How often do you use ganja when it could be dangerous (driving, machines, caring for children)?", "কতবার বিপজ্জনক অবস্থায় (গাড়ি/বাইক চালানো, মেশিন চালানো, শিশুর দেখাশোনা) গাঁজা খান?"), options: FREQUENCY_6M },
      {
        text: L("Have you ever thought about cutting down or stopping?", "কখনো কি কমানো বা ছেড়ে দেওয়ার কথা ভেবেছেন?"),
        options: [
          { label: L("Never", "কখনো না"), score: 0 },
          { label: L("Yes, but not in the past 6 months", "হ্যাঁ, তবে গত ৬ মাসে নয়"), score: 2 },
          { label: L("Yes, in the past 6 months", "হ্যাঁ, গত ৬ মাসে"), score: 4 },
        ],
      },
    ],
  },
  SDS: {
    title: L("How strong is the hold? (Severity of Dependence Scale)", "নেশার টান কতটা? (Severity of Dependence Scale)"),
    thresholds: { high: 9 },
    maxScore: 15,
    questions: [
      { text: L("In the last month, did you feel your use of {substance} was out of control?", "গত এক মাসে কি মনে হয়েছে {substance} নেওয়া আপনার নিয়ন্ত্রণের বাইরে?"), options: SDS_OFTEN },
      { text: L("Did the thought of missing a dose make you anxious or worried?", "না পেলে কী হবে—এই চিন্তায় কি অস্থির বা দুশ্চিন্তাগ্রস্ত হয়েছেন?"), options: SDS_OFTEN },
      { text: L("Did you worry about your use of {substance}?", "{substance} নেওয়া নিয়ে কি আপনি চিন্তিত ছিলেন?"), options: SDS_OFTEN },
      { text: L("Did you wish you could stop?", "কি মনে হয়েছে—ইস, যদি ছাড়তে পারতাম?"), options: SDS_OFTEN },
      {
        text: L("How difficult would it be to stop or go without {substance}?", "{substance} ছাড়া থাকা বা একেবারে ছেড়ে দেওয়া আপনার কাছে কতটা কঠিন মনে হয়?"),
        options: [
          { label: L("Not difficult", "কঠিন না"), score: 0 },
          { label: L("Quite difficult", "বেশ কঠিন"), score: 1 },
          { label: L("Very difficult", "খুব কঠিন"), score: 2 },
          { label: L("Impossible", "অসম্ভব"), score: 3 },
        ],
      },
    ],
  },
  "AUDIT-C": {
    title: L("Alcohol use (AUDIT-C)", "মদ্যপান (AUDIT-C)"),
    thresholds: { moderate: 4, high: 8 },
    maxScore: 12,
    questions: [
      { text: L("How often do you have a drink containing alcohol?", "কত ঘন ঘন মদ/অ্যালকোহল পান করেন?"), options: USE_FREQUENCY },
      {
        text: L("How many drinks do you have on a typical day when you drink?", "যেদিন পান করেন, সাধারণত কয় গ্লাস/পেগ?"),
        options: [
          { label: L("1–2", "১–২"), score: 0 },
          { label: L("3–4", "৩–৪"), score: 1 },
          { label: L("5–6", "৫–৬"), score: 2 },
          { label: L("7–9", "৭–৯"), score: 3 },
          { label: L("10 or more", "১০ বা বেশি"), score: 4 },
        ],
      },
      { text: L("How often do you have 6 or more drinks on one occasion?", "কতবার একবারে ৬ গ্লাস/পেগ বা তার বেশি পান করেন?"), options: FREQUENCY_6M },
    ],
  },
};

// ---------------------------------------------------------------------------
// Onboarding choices.
// ---------------------------------------------------------------------------
const TRIGGERS = [
  { key: "stress", label: L("Stress", "মানসিক চাপ"), ifThen: L("If I feel stressed, then I will do 2 minutes of box breathing and take a short walk.", "চাপ লাগলে, আমি ২ মিনিট বক্স-ব্রিদিং করব আর একটু হাঁটব।") },
  { key: "boredom", label: L("Boredom", "একঘেয়েমি"), ifThen: L("If I'm bored, then I will call a friend who doesn't use, or play a game for 10 minutes.", "একঘেয়ে লাগলে, আমি এমন বন্ধুকে ফোন দেব যে নেশা করে না, বা ১০ মিনিট একটা গেম খেলব।") },
  { key: "loneliness", label: L("Loneliness", "একাকীত্ব"), ifThen: L("If I feel lonely, then I will message my support person or go where people are.", "একা লাগলে, আমি সাপোর্ট পার্সনকে মেসেজ দেব বা মানুষের মাঝে যাব।") },
  { key: "friends", label: L("Friends / adda", "বন্ধু / আড্ডা"), ifThen: L("If friends offer, then I will say \"No thanks, I've quit\" and leave within 5 minutes.", "বন্ধুরা অফার করলে, আমি বলব \"না ভাই, ছেড়ে দিয়েছি\"—আর ৫ মিনিটের মধ্যে সরে যাব।") },
  { key: "tea_stall", label: L("Tea stall", "চায়ের দোকান"), ifThen: L("If I'm at the tea stall, then I will have tea without smoking, keep my hands busy and not stay long.", "চায়ের দোকানে গেলে, আমি সিগারেট ছাড়া চা খাব, হাত ব্যস্ত রাখব আর বেশিক্ষণ থাকব না।") },
  { key: "after_meals", label: L("After meals", "খাওয়ার পর"), ifThen: L("After meals, I will get up, brush my teeth or chew mouri, and walk for 5 minutes.", "খাওয়ার পর, আমি উঠে দাঁত ব্রাশ করব বা মৌরি চিবাব, আর ৫ মিনিট হাঁটব।") },
  { key: "late_night", label: L("Late night", "গভীর রাত"), ifThen: L("If I'm awake late at night, then I will put the phone away, breathe slowly and listen to something calming.", "গভীর রাতে জেগে থাকলে, আমি ফোন রেখে ধীরে শ্বাস নেব আর শান্ত কিছু শুনব।") },
  { key: "money", label: L("Money in hand", "হাতে টাকা"), ifThen: L("When I have cash, I will give the extra to family or put it into savings straight away.", "হাতে টাকা এলে, বাড়তি টাকা সাথে সাথে পরিবারকে দেব বা সঞ্চয়ে রেখে দেব।") },
  { key: "family_conflict", label: L("Family conflict", "পারিবারিক ঝামেলা"), ifThen: L("If there's a fight at home, then I will step outside for 10 minutes and breathe before I talk.", "বাসায় ঝগড়া হলে, আমি ১০ মিনিট বাইরে গিয়ে শ্বাস নিয়ে তারপর কথা বলব।") },
  { key: "work_study", label: L("Work / exam pressure", "কাজ / পরীক্ষার চাপ"), ifThen: L("If pressure builds, then I will break the task into one small step and take a 5-minute break.", "চাপ বাড়লে, আমি কাজটা ছোট এক ধাপে ভাগ করব আর ৫ মিনিট বিরতি নেব।") },
  { key: "celebration", label: L("Parties & weddings", "পার্টি / বিয়েবাড়ি"), ifThen: L("Before a party or wedding, I will plan who I'll stay with, what I'll drink and when I'll leave.", "পার্টি বা বিয়েবাড়িতে যাওয়ার আগে, কার সাথে থাকব, কী পান করব আর কখন চলে আসব—ঠিক করে যাব।") },
  { key: "anger", label: L("Anger", "রাগ"), ifThen: L("If I get angry, then I will walk away, count to 20 and splash cold water on my face.", "রাগ উঠলে, আমি সরে যাব, ২০ পর্যন্ত গুনব আর মুখে ঠান্ডা পানি দেব।") },
  { key: "sadness", label: L("Sadness", "মন খারাপ"), ifThen: L("If I feel low, then I will talk to someone and do one small thing I enjoy.", "মন খারাপ হলে, আমি কারো সাথে কথা বলব আর পছন্দের ছোট একটা কাজ করব।") },
  { key: "cant_sleep", label: L("Can't sleep", "ঘুম না আসা"), ifThen: L("If I can't sleep, then I will get up, keep the lights low and breathe slowly instead of using.", "ঘুম না এলে, আমি উঠে আলো কমিয়ে ধীরে শ্বাস নেব—নেশার বদলে।") },
  { key: "places", label: L("Certain places", "নির্দিষ্ট জায়গা"), ifThen: L("If I have to pass a risky place, then I will take another route or go with someone supportive.", "ঝুঁকির জায়গা পার হতে হলে, আমি অন্য পথে যাব বা সহায়ক কাউকে সাথে নেব।") },
  { key: "social_media", label: L("Social media / videos", "সোশ্যাল মিডিয়া / ভিডিও"), ifThen: L("If posts or videos trigger me, then I will mute them and close the app for 30 minutes.", "পোস্ট বা ভিডিও দেখে ইচ্ছে জাগলে, আমি সেগুলো মিউট করে ৩০ মিনিট অ্যাপ বন্ধ রাখব।") },
];
const TRIGGER_KEYS = TRIGGERS.map((item) => item.key);

const REASONS = [
  { key: "health", label: L("My health", "আমার স্বাস্থ্য") },
  { key: "family", label: L("My family", "আমার পরিবার") },
  { key: "children", label: L("My children", "আমার সন্তান") },
  { key: "money", label: L("Save money", "টাকা বাঁচানো") },
  { key: "study_career", label: L("Study & career", "পড়াশোনা ও ক্যারিয়ার") },
  { key: "faith", label: L("My faith", "আমার ধর্মবিশ্বাস") },
  { key: "respect", label: L("Self-respect", "আত্মসম্মান") },
  { key: "partner", label: L("My partner", "আমার জীবনসঙ্গী") },
  { key: "legal", label: L("Stay safe from legal trouble", "আইনি ঝামেলা থেকে দূরে থাকা") },
  { key: "sleep", label: L("Better sleep", "ভালো ঘুম") },
  { key: "freedom", label: L("Be free and in control", "মুক্ত থাকা, নিজের নিয়ন্ত্রণে থাকা") },
  { key: "fitness", label: L("Strength & fitness", "শক্তি ও ফিটনেস") },
];
const REASON_KEYS = REASONS.map((item) => item.key);

const HALT = [
  { key: "hungry", label: L("Hungry", "ক্ষুধার্ত") },
  { key: "angry", label: L("Angry", "রাগান্বিত") },
  { key: "lonely", label: L("Lonely", "একা") },
  { key: "tired", label: L("Tired", "ক্লান্ত") },
];
const HALT_KEYS = HALT.map((item) => item.key);

// ---------------------------------------------------------------------------
// Personal background ("About you"). Every question is optional. The answers
// are stored encrypted and only used to personalise the plan, coach and safety
// advice. `none` options clear the others in the app.
// ---------------------------------------------------------------------------
const opt = (key, en, bn, extra = {}) => ({ key, label: L(en, bn), ...extra });

const BACKGROUND = {
  ageGroup: [
    opt("under18", "Under 18", "১৮-এর কম"),
    opt("18_24", "18–24", "১৮–২৪"),
    opt("25_34", "25–34", "২৫–৩৪"),
    opt("35_49", "35–49", "৩৫–৪৯"),
    opt("50plus", "50 or older", "৫০ বা বেশি"),
  ],
  gender: [
    opt("male", "Man", "পুরুষ"),
    opt("female", "Woman", "নারী"),
    opt("other", "Other / prefer not to say", "অন্য / বলতে চাই না"),
  ],
  living: [
    opt("alone", "Alone", "একা"),
    opt("family", "With family", "পরিবারের সাথে"),
    opt("partner", "With my partner", "জীবনসঙ্গীর সাথে"),
    opt("shared", "Mess / hostel / shared", "মেস / হোস্টেল / শেয়ার বাসা"),
    opt("users_nearby", "Someone I live with also uses", "যার সাথে থাকি সে-ও নেশা করে"),
  ],
  familyKnows: [
    opt("yes", "Yes, they know", "হ্যাঁ, জানে"),
    opt("some", "Some people know", "কেউ কেউ জানে"),
    opt("no", "No one knows", "কেউ জানে না"),
  ],
  occupation: [
    opt("student", "Student", "শিক্ষার্থী"),
    opt("working", "Job (day time)", "চাকরি (দিনে)"),
    opt("night_shift", "Night shift / long hours", "রাতের শিফট / লম্বা সময় কাজ"),
    opt("business", "Own business", "নিজের ব্যবসা"),
    opt("driver", "Driver / transport", "চালক / পরিবহন"),
    opt("homemaker", "Homemaker", "গৃহিণী / গৃহকর্তা"),
    opt("unemployed", "Looking for work", "কাজ খুঁজছি"),
  ],
  access: [
    opt("very_easy", "Very easy — it comes to me", "খুব সহজ—হাতের কাছেই পাই"),
    opt("somewhat", "I have to go and get it", "গিয়ে আনতে হয়"),
    opt("hard", "Hard to get", "পাওয়া কঠিন"),
  ],
  routes: [
    opt("smoke", "Smoke / foil / chase", "ধোঁয়া / ফয়েল"),
    opt("oral", "Swallow / drink", "খাই / পান করি"),
    opt("sniff", "Sniff / snort", "নাকে টানি"),
    opt("chew", "Chew", "চিবাই"),
    opt("inject", "Inject", "ইনজেকশন"),
    opt("vape", "Vape", "ভেপ"),
  ],
  usePattern: [
    opt("alone", "Mostly alone", "বেশিরভাগ একা"),
    opt("friends", "Mostly with friends", "বেশিরভাগ বন্ধুদের সাথে"),
    opt("both", "Both", "দুইভাবেই"),
  ],
  // What use does for the person, and a healthier way to meet the same need.
  functions: [
    opt("relax", "Calms stress", "চাপ কমায়", { replacement: L("Box breathing, a walk or a shower when stress builds; talk it out with someone.", "চাপ বাড়লে বক্স-ব্রিদিং, হাঁটা বা গোসল; কারো সাথে কথা বলা।") }),
    opt("sleep", "Helps me sleep", "ঘুমাতে সাহায্য করে", { replacement: L("A fixed bedtime, no screens for 30 minutes, and slow 4-7-8 breathing in bed.", "নির্দিষ্ট সময়ে ঘুমানো, ৩০ মিনিট স্ক্রিন বন্ধ, বিছানায় ধীরে ৪-৭-৮ শ্বাস।") }),
    opt("energy", "Energy for work or study", "কাজ বা পড়ার শক্তি", { replacement: L("Regular meals, water, short breaks every hour and 7 hours of sleep.", "সময়মতো খাবার, পানি, প্রতি ঘণ্টায় ছোট বিরতি আর ৭ ঘণ্টা ঘুম।") }),
    opt("fun", "Fun / fitting in with friends", "মজা / বন্ধুদের সাথে মিশতে", { replacement: L("Plan sober hangouts: sport, games, food or a movie with friends who don't use.", "নেশা ছাড়া আড্ডা: খেলা, গেম, খাওয়া বা সিনেমা—নেশা করে না এমন বন্ধুদের সাথে।") }),
    opt("pain", "Eases body pain", "শরীরের ব্যথা কমায়", { replacement: L("See a doctor for a safe pain plan; gentle stretching and heat packs can help.", "নিরাপদ ব্যথার চিকিৎসার জন্য ডাক্তার দেখান; হালকা স্ট্রেচিং আর গরম সেঁক সাহায্য করে।") }),
    opt("escape", "Escape bad feelings or memories", "খারাপ অনুভূতি বা স্মৃতি থেকে পালাতে", { replacement: L("Write the feeling down, use 5-4-3-2-1 grounding, and talk to a counsellor.", "অনুভূতিটা লিখে ফেলুন, ৫-৪-৩-২-১ গ্রাউন্ডিং করুন, আর কাউন্সেলরের সাথে কথা বলুন।") }),
    opt("boredom", "Kills boredom", "একঘেয়েমি কাটায়", { replacement: L("Keep a list of 5 quick activities and fill empty evenings with a class, sport or hobby.", "৫টা ছোট কাজের তালিকা রাখুন, খালি সন্ধ্যায় ক্লাস, খেলা বা শখের কাজ করুন।") }),
    opt("confidence", "Makes me feel confident", "আত্মবিশ্বাস দেয়", { replacement: L("Practise one small social step at a time and note each success.", "একবারে একটা ছোট সামাজিক পদক্ষেপ অনুশীলন করুন, প্রতিটি সফলতা লিখে রাখুন।") }),
    opt("withdrawal", "Stops withdrawal feeling bad", "না নিলে খারাপ লাগে, তাই", { replacement: L("Ask a doctor about medicines that ease withdrawal — this makes quitting much safer.", "উইথড্রয়াল সহজ করার ওষুধ নিয়ে ডাক্তারকে জিজ্ঞেস করুন—এতে ছাড়া অনেক নিরাপদ হয়।") }),
    opt("habit", "Just habit / routine", "শুধু অভ্যাস", { replacement: L("Swap the ritual: same time and place, new action — tea, mouri, a short walk.", "অভ্যাসটা বদলান: একই সময় ও জায়গা, নতুন কাজ—চা, মৌরি, একটু হাঁটা।") }),
  ],
  longestQuit: [
    opt("never", "Never tried", "কখনো চেষ্টা করিনি"),
    opt("days", "A few days", "কয়েক দিন"),
    opt("weeks", "A few weeks", "কয়েক সপ্তাহ"),
    opt("months", "A few months", "কয়েক মাস"),
    opt("year", "A year or more", "এক বছর বা বেশি"),
  ],
  relapseReasons: [
    opt("withdrawal", "Withdrawal was too hard", "উইথড্রয়াল খুব কষ্টের ছিল"),
    opt("cravings", "Cravings", "তীব্র ইচ্ছে"),
    opt("friends", "Friends / offers", "বন্ধু / অফার"),
    opt("stress", "Stress or problems", "চাপ বা সমস্যা"),
    opt("boredom", "Boredom", "একঘেয়েমি"),
    opt("sleep", "Couldn't sleep", "ঘুম আসত না"),
    opt("pain", "Pain", "ব্যথা"),
    opt("celebration", "A celebration", "কোনো উৎসব"),
    opt("thought_ok", "Thought 'just once is okay'", "ভেবেছিলাম 'একবার খেলে কিছু হবে না'"),
  ],
  pastWithdrawal: [
    opt("seizure", "Seizure / fits", "খিঁচুনি", { redFlag: true }),
    opt("hallucinations", "Seeing or hearing things, severe confusion", "কিছু দেখা/শোনা, খুব বিভ্রান্তি", { redFlag: true }),
    opt("shaking", "Severe shaking or sweating", "প্রচণ্ড কাঁপুনি বা ঘাম", { redFlag: true }),
    opt("suicidal", "Very low mood or thoughts of suicide", "খুব মন খারাপ বা আত্মহত্যার চিন্তা", { redFlag: true }),
    opt("vomiting", "Vomiting, diarrhoea, body aches", "বমি, পাতলা পায়খানা, শরীর ব্যথা"),
    opt("anxiety", "Anxiety, irritability, poor sleep", "উদ্বেগ, খিটখিটে ভাব, ঘুমের সমস্যা"),
    opt("none", "None / never stopped", "কিছু না / কখনো ছাড়িনি"),
  ],
  mentalHealth: [
    opt("anxiety", "Anxiety / panic", "উদ্বেগ / প্যানিক"),
    opt("depression", "Depression / low mood", "বিষণ্ণতা / মন খারাপ"),
    opt("sleep", "Sleep problems", "ঘুমের সমস্যা"),
    opt("anger", "Anger problems", "রাগের সমস্যা"),
    opt("adhd", "ADHD / trouble focusing", "এডিএইচডি / মনোযোগের সমস্যা"),
    opt("trauma", "Trauma / bad past experiences", "ট্রমা / খারাপ অতীত অভিজ্ঞতা"),
    opt("self_harm", "Past self-harm or suicidal thoughts", "আগে নিজের ক্ষতি বা আত্মহত্যার চিন্তা"),
    opt("none", "None", "কিছু না"),
  ],
  physicalHealth: [
    opt("pregnant", "Pregnant or breastfeeding", "গর্ভবতী বা বুকের দুধ খাওয়াচ্ছি"),
    opt("heart", "Heart problem / high blood pressure", "হৃদরোগ / উচ্চ রক্তচাপ"),
    opt("epilepsy", "Epilepsy / past seizures", "মৃগী / আগে খিঁচুনি"),
    opt("liver", "Liver problem / jaundice", "লিভারের সমস্যা / জন্ডিস"),
    opt("lungs", "Asthma / lung problem", "হাঁপানি / ফুসফুসের সমস্যা"),
    opt("diabetes", "Diabetes", "ডায়াবেটিস"),
    opt("hiv_hep", "HIV or hepatitis", "এইচআইভি বা হেপাটাইটিস"),
    opt("chronic_pain", "Long-term pain", "দীর্ঘমেয়াদি ব্যথা"),
    opt("none", "None", "কিছু না"),
  ],
  treatment: [
    opt("doctor", "Seeing a doctor", "ডাক্তার দেখাচ্ছি"),
    opt("medicine", "Taking medicine for quitting", "ছাড়ার জন্য ওষুধ খাচ্ছি"),
    opt("counselling", "Counselling", "কাউন্সেলিং"),
    opt("rehab_past", "Was in rehab before", "আগে রিহ্যাবে ছিলাম"),
    opt("group", "NA / AA / support group", "এনএ / এএ / সাপোর্ট গ্রুপ"),
    opt("faith", "Religious leader / faith group", "ধর্মীয় নেতা / ধর্মীয় দল"),
    opt("none", "No support yet", "এখনো কোনো সহায়তা নেই"),
  ],
  interests: [
    opt("sport", "Cricket / football / sport", "ক্রিকেট / ফুটবল / খেলা"),
    opt("gym", "Gym / exercise", "জিম / ব্যায়াম"),
    opt("music", "Music", "গান-বাজনা"),
    opt("prayer", "Prayer / faith", "নামাজ / প্রার্থনা"),
    opt("reading", "Reading / learning", "পড়া / শেখা"),
    opt("games", "Games", "গেম"),
    opt("cooking", "Cooking", "রান্না"),
    opt("art", "Art / writing / photos", "আঁকা / লেখা / ছবি তোলা"),
    opt("nature", "Walks / nature / gardening", "হাঁটা / প্রকৃতি / বাগান"),
    opt("family_time", "Time with family or kids", "পরিবার বা বাচ্চাদের সাথে সময়"),
    opt("helping", "Helping others / volunteering", "অন্যকে সাহায্য / স্বেচ্ছাসেবা"),
    opt("skills", "Learning a skill / earning", "দক্ষতা শেখা / আয় করা"),
  ],
};

const BACKGROUND_MULTI = ["living", "routes", "functions", "relapseReasons", "pastWithdrawal", "mentalHealth", "physicalHealth", "treatment", "interests"];
const BACKGROUND_SINGLE = ["ageGroup", "gender", "familyKnows", "occupation", "access", "usePattern", "longestQuit"];
const backgroundKeys = (field) => (BACKGROUND[field] || []).map((item) => item.key);

// Curated safety notes triggered by background answers (never AI-generated).
const BACKGROUND_SAFETY = {
  pregnant: L(
    "You are pregnant or breastfeeding: please see a doctor before you stop. Stopping opioids, alcohol, sedatives or pregabalin suddenly can harm you and the baby — a doctor can make it safe.",
    "আপনি গর্ভবতী বা বুকের দুধ খাওয়াচ্ছেন: ছাড়ার আগে অবশ্যই ডাক্তার দেখান। অপিয়য়েড, মদ, ঘুমের ওষুধ বা প্রিগাবালিন হঠাৎ বন্ধ করলে আপনার ও শিশুর ক্ষতি হতে পারে—ডাক্তার এটা নিরাপদ করতে পারেন।",
  ),
  inject: L(
    "If you inject: never share needles or syringes, use new ones every time, and get a free HIV and hepatitis test. Injecting after a break carries a very high overdose risk.",
    "ইনজেকশন নিলে: কখনো সুই-সিরিঞ্জ শেয়ার করবেন না, প্রতিবার নতুন ব্যবহার করুন, আর বিনামূল্যে এইচআইভি ও হেপাটাইটিস পরীক্ষা করান। বিরতির পর ইনজেকশন নিলে ওভারডোজের ঝুঁকি অনেক বেশি।",
  ),
  seizure_history: L(
    "You have had seizures or severe withdrawal before. Your next withdrawal can be worse, so please plan it with a doctor and don't be alone for the first days.",
    "আগে আপনার খিঁচুনি বা তীব্র উইথড্রয়াল হয়েছে। পরেরবার তা আরও খারাপ হতে পারে, তাই ডাক্তারের সাথে পরিকল্পনা করুন আর প্রথম কয়েকদিন একা থাকবেন না।",
  ),
  heart: L(
    "With a heart problem, stimulants like yaba, ICE and cocaine are especially dangerous. Chest pain or a racing heart needs 999 straight away.",
    "হৃদরোগ থাকলে ইয়াবা, আইস বা কোকেনের মতো উত্তেজক মাদক বিশেষভাবে বিপজ্জনক। বুকে ব্যথা বা বুক ধড়ফড় করলে সাথে সাথে ৯৯৯-এ ফোন করুন।",
  ),
  tramadol_seizure: L(
    "Tramadol can cause seizures, especially with epilepsy or at high amounts. Cut down with a doctor rather than stopping suddenly on your own.",
    "ট্রামাডল খিঁচুনি ঘটাতে পারে, বিশেষ করে মৃগী থাকলে বা বেশি পরিমাণে নিলে। নিজে হঠাৎ বন্ধ না করে ডাক্তারের সাথে ধীরে কমান।",
  ),
  self_harm: L(
    "You have had thoughts of self-harm before, and mood can drop during withdrawal. Keep Kaan Pete Roi (09612-119911) and a trusted person close, and call 999 if you feel unsafe.",
    "আগে আপনার নিজের ক্ষতির চিন্তা এসেছে, আর উইথড্রয়ালে মন আরও খারাপ হতে পারে। কান পেতে রই (০৯৬১২-১১৯৯১১) আর একজন বিশ্বস্ত মানুষকে কাছে রাখুন, অনিরাপদ মনে হলে ৯৯৯-এ ফোন করুন।",
  ),
  alone_opioid: L(
    "You live alone and use opioids: overdose is most deadly when no one is around. Tell someone your plan and never use alone.",
    "আপনি একা থাকেন এবং অপিয়য়েড নেন: আশেপাশে কেউ না থাকলে ওভারডোজ সবচেয়ে প্রাণঘাতী। কাউকে আপনার পরিকল্পনা জানান, কখনো একা নেবেন না।",
  ),
  under18: L(
    "You are under 18: a trusted adult, school counsellor or the Child Helpline (1098, free, 24/7) can help you through this safely.",
    "আপনার বয়স ১৮-এর কম: একজন বিশ্বস্ত বড় মানুষ, স্কুলের কাউন্সেলর বা শিশু হেল্পলাইন (১০৯৮, বিনামূল্যে, ২৪ ঘণ্টা) আপনাকে নিরাপদে সাহায্য করতে পারে।",
  ),
};

// Extra "cut the ties" steps suggested by background answers.
const BACKGROUND_CHECKLIST = {
  users_nearby: L("Agree with the person you live with that they won't use or keep drugs around you", "যার সাথে থাকেন তার সাথে কথা বলুন—আপনার সামনে যেন নেশা না করে বা জিনিস না রাখে"),
  very_easy: L("Block the seller's number and change the times and routes where you meet them", "বিক্রেতার নম্বর ব্লক করুন, আর যে সময়/পথে দেখা হয় তা বদলান"),
  inject: L("Get a free HIV and hepatitis test and throw away old needles safely", "বিনামূল্যে এইচআইভি ও হেপাটাইটিস পরীক্ষা করান, পুরনো সুই নিরাপদে ফেলে দিন"),
  night_shift: L("Plan a meal, water and a 10-minute break for the hardest hour of your shift", "শিফটের সবচেয়ে কঠিন সময়ের জন্য খাবার, পানি আর ১০ মিনিটের বিরতি ঠিক করুন"),
  no_support: L("Book one visit with a doctor or counsellor this month", "এই মাসে একবার ডাক্তার বা কাউন্সেলরের কাছে যাওয়ার সময় ঠিক করুন"),
  family_unaware: L("Choose one person you could tell, and what you would say", "কাকে জানাতে পারেন আর কী বলবেন—একজন মানুষ ঠিক করুন"),
};

// Common early warning signs of a relapse; the curated plan picks from these.
const WARNING_SIGNS = {
  common: [
    L("Skipping check-ins or hiding how I feel", "চেক-ইন বাদ দেওয়া বা অনুভূতি লুকানো"),
    L("Thinking 'just once won't hurt'", "ভাবা 'একবার খেলে কিছু হবে না'"),
    L("Spending time near old using places or people", "পুরনো নেশার জায়গা বা মানুষের কাছে সময় কাটানো"),
  ],
  sleep: L("Sleeping badly for several nights", "কয়েক রাত ধরে ঠিকমতো ঘুম না হওয়া"),
  depression: L("Staying in my room and not talking to anyone", "ঘরে বসে থাকা, কারো সাথে কথা না বলা"),
  anger: L("Getting into more arguments than usual", "স্বাভাবিকের চেয়ে বেশি ঝগড়া করা"),
  anxiety: L("Feeling on edge and restless for days", "কয়েকদিন ধরে অস্থির আর টেনশনে থাকা"),
  money: L("Carrying extra cash for no reason", "অকারণে বাড়তি টাকা সাথে রাখা"),
};

// Withdrawal and health symptoms for the daily check-in. A red flag names the
// crisis type and shows emergency help straight away.
const SYMPTOMS = [
  opt("shaking", "Shaking", "কাঁপুনি"),
  opt("sweating", "Sweating / chills", "ঘাম / শীত শীত ভাব"),
  opt("nausea", "Nausea / vomiting", "বমি ভাব / বমি"),
  opt("diarrhoea", "Diarrhoea / stomach cramps", "পাতলা পায়খানা / পেট কামড়ানো"),
  opt("aches", "Body aches", "শরীর ব্যথা"),
  opt("headache", "Headache", "মাথাব্যথা"),
  opt("anxious", "Anxious / restless", "উদ্বেগ / অস্থিরতা"),
  opt("irritable", "Irritable", "খিটখিটে মেজাজ"),
  opt("low_mood", "Low mood", "মন খারাপ"),
  opt("no_sleep", "Can't sleep", "ঘুম আসে না"),
  opt("exhausted", "Exhausted", "প্রচণ্ড ক্লান্তি"),
  opt("hungry", "Very hungry", "খুব খিদে"),
  opt("seizure", "Seizure / fits", "খিঁচুনি", { redFlag: "medical" }),
  opt("hallucinations", "Seeing or hearing things", "এমন কিছু দেখা বা শোনা যা অন্যরা পায় না", { redFlag: "psychosis" }),
  opt("confusion", "Severe confusion", "খুব বিভ্রান্তি", { redFlag: "medical" }),
  opt("chest_pain", "Chest pain / racing heart", "বুকে ব্যথা / বুক ধড়ফড়", { redFlag: "medical" }),
  opt("breathing", "Trouble breathing", "শ্বাসকষ্ট", { redFlag: "medical" }),
  opt("suicidal", "Thoughts of ending my life", "জীবন শেষ করার চিন্তা", { redFlag: "suicide" }),
];
const SYMPTOM_KEYS = SYMPTOMS.map((item) => item.key);

// SOS tools. The client renders them offline; the server needs the keys to rank
// them and to validate the coach's suggestedTool.
const TOOL_KEYS = ["urge_surf", "breathing", "reasons", "tape_forward", "grounding", "four_ds", "distract", "call_support", "coach"];
const SUGGESTED_TOOL_KEYS = ["none", "breathing", "urge_surf", "reasons", "grounding", "tape_forward", "distract", "call_support", "help"];

// ---------------------------------------------------------------------------
// Milestones, badges and points.
// ---------------------------------------------------------------------------
const MILESTONES = [
  { days: 1, label: L("24 hours", "২৪ ঘণ্টা") },
  { days: 3, label: L("3 days", "৩ দিন") },
  { days: 7, label: L("1 week", "১ সপ্তাহ") },
  { days: 14, label: L("2 weeks", "২ সপ্তাহ") },
  { days: 30, label: L("1 month", "১ মাস") },
  { days: 60, label: L("2 months", "২ মাস") },
  { days: 90, label: L("3 months", "৩ মাস") },
  { days: 180, label: L("6 months", "৬ মাস") },
  { days: 365, label: L("1 year", "১ বছর") },
];

const BADGES = {
  ...Object.fromEntries(MILESTONES.map((milestone) => [`clean_${milestone.days}`, { icon: "medal-outline", label: L(`${milestone.label.en} free`, `${milestone.label.bn} মুক্ত`) }])),
  cravings_1: { icon: "shield-check-outline", label: L("First craving beaten", "প্রথম ইচ্ছে জয়") },
  cravings_10: { icon: "shield-star-outline", label: L("10 cravings beaten", "১০টি ইচ্ছে জয়") },
  cravings_50: { icon: "shield-crown-outline", label: L("50 cravings beaten", "৫০টি ইচ্ছে জয়") },
  cravings_100: { icon: "trophy-outline", label: L("100 cravings beaten", "১০০টি ইচ্ছে জয়") },
  checkins_7: { icon: "calendar-check-outline", label: L("7 check-ins", "৭টি চেক-ইন") },
  checkins_30: { icon: "calendar-star", label: L("30 check-ins", "৩০টি চেক-ইন") },
  honest_restart: { icon: "sprout-outline", label: L("Honest restart", "সৎ নতুন শুরু") },
};

const POINTS = { checkin: 10, craving_resisted: 20, sos_done: 10, lesson: 5, journal: 5, roleplay: 15, plan: 10 };

// ---------------------------------------------------------------------------
// Health-recovery timelines (hours after the last use). WHO / CDC for tobacco,
// NIDA and clinical withdrawal literature for the others.
// ---------------------------------------------------------------------------
const H = 1;
const DAYS = 24;
const TIMELINES = {
  cigarette: [
    { hours: 20 / 60, at: L("20 minutes", "২০ মিনিট"), text: L("Heart rate and blood pressure start to drop.", "হৃদস্পন্দন ও রক্তচাপ কমতে শুরু করে।") },
    { hours: 12 * H, at: L("12 hours", "১২ ঘণ্টা"), text: L("Carbon monoxide in your blood falls to normal.", "রক্তে কার্বন মনোক্সাইডের মাত্রা স্বাভাবিক হয়।") },
    { hours: 2 * DAYS, at: L("2 days", "২ দিন"), text: L("Smell and taste begin to improve.", "ঘ্রাণ আর স্বাদ ফিরতে শুরু করে।") },
    { hours: 3 * DAYS, at: L("3 days", "৩ দিন"), text: L("Nicotine has left your body. Cravings peak now and then start to ease.", "শরীর থেকে নিকোটিন বের হয়ে গেছে। এখন ইচ্ছে সবচেয়ে বেশি, তারপর কমতে শুরু করবে।") },
    { hours: 14 * DAYS, at: L("2 weeks – 3 months", "২ সপ্তাহ – ৩ মাস"), text: L("Circulation and lung function improve.", "রক্তসঞ্চালন আর ফুসফুসের কাজ ভালো হয়।") },
    { hours: 30 * DAYS, at: L("1–9 months", "১–৯ মাস"), text: L("Coughing and shortness of breath decrease.", "কাশি আর শ্বাসকষ্ট কমে।") },
    { hours: 365 * DAYS, at: L("1 year", "১ বছর"), text: L("Your risk of heart disease is about half that of a smoker.", "হৃদরোগের ঝুঁকি ধূমপায়ীর প্রায় অর্ধেক হয়ে যায়।") },
    { hours: 5 * 365 * DAYS, at: L("5 years", "৫ বছর"), text: L("Stroke risk keeps falling towards that of a non-smoker.", "স্ট্রোকের ঝুঁকি কমতে কমতে অধূমপায়ীর কাছাকাছি চলে আসে।") },
    { hours: 10 * 365 * DAYS, at: L("10 years", "১০ বছর"), text: L("Risk of dying from lung cancer is about half that of a smoker.", "ফুসফুসের ক্যান্সারে মৃত্যুঝুঁকি ধূমপায়ীর প্রায় অর্ধেক।") },
    { hours: 15 * 365 * DAYS, at: L("15 years", "১৫ বছর"), text: L("Heart disease risk is close to that of a non-smoker.", "হৃদরোগের ঝুঁকি অধূমপায়ীর কাছাকাছি।") },
  ],
  smokeless: [
    { hours: 1 * DAYS, at: L("1 day", "১ দিন"), text: L("Nicotine levels fall; urges are strong for the first days.", "নিকোটিনের মাত্রা কমে; প্রথম কয়েকদিন ইচ্ছে তীব্র থাকে।") },
    { hours: 3 * DAYS, at: L("3 days", "৩ দিন"), text: L("Cravings peak and then start to ease.", "ইচ্ছে সবচেয়ে বেশি থাকে, তারপর কমতে শুরু করে।") },
    { hours: 14 * DAYS, at: L("2–6 weeks", "২–৬ সপ্তাহ"), text: L("Mouth sores and gum irritation often begin to heal.", "মুখের ঘা আর মাড়ির জ্বালা সাধারণত সারতে শুরু করে।") },
    { hours: 90 * DAYS, at: L("3 months", "৩ মাস"), text: L("Blood pressure and heart rate are healthier; urges are much rarer.", "রক্তচাপ আর হৃদস্পন্দন ভালো থাকে; ইচ্ছে অনেক কম আসে।") },
    { hours: 365 * DAYS, at: L("1 year and beyond", "১ বছর ও তার পরে"), text: L("Your risk of mouth and throat cancer keeps falling year after year.", "মুখ ও গলার ক্যান্সারের ঝুঁকি বছর বছর কমতে থাকে।") },
  ],
  stimulant: [
    { hours: 1 * DAYS, at: L("Days 1–3", "১–৩ দিন"), text: L("The crash: deep tiredness, long sleep, hunger and low mood. Rest, eat and drink water.", "ক্র্যাশ: প্রচণ্ড ক্লান্তি, অনেক ঘুম, খিদে আর মন খারাপ। বিশ্রাম নিন, খান, পানি খান।") },
    { hours: 4 * DAYS, at: L("Days 4–10", "৪–১০ দিন"), text: L("The hardest stretch: strong cravings, irritability and poor sleep. Use SOS as often as you need.", "সবচেয়ে কঠিন সময়: তীব্র ইচ্ছে, খিটখিটে মেজাজ, ঘুমের সমস্যা। যতবার দরকার SOS ব্যবহার করুন।") },
    { hours: 14 * DAYS, at: L("Weeks 2–4", "২–৪ সপ্তাহ"), text: L("Sleep and appetite settle and energy slowly returns.", "ঘুম আর খাওয়া স্বাভাবিক হয়, শক্তি ধীরে ধীরে ফেরে।") },
    { hours: 30 * DAYS, at: L("Months 1–3", "১–৩ মাস"), text: L("Mood and focus keep improving. Cravings come less often but people and places can still trigger them.", "মন আর মনোযোগ ভালো হতে থাকে। ইচ্ছে কম আসে, তবে মানুষ বা জায়গা দেখে জাগতে পারে।") },
    { hours: 180 * DAYS, at: L("Months 6–12", "৬–১২ মাস"), text: L("Memory, attention and motivation are noticeably better.", "স্মৃতিশক্তি, মনোযোগ আর আগ্রহ বেশ ভালো হয়।") },
    { hours: 365 * DAYS, at: L("1 year+", "১ বছর+"), text: L("Research shows the brain's reward system can recover substantially after long abstinence.", "গবেষণায় দেখা যায়, দীর্ঘদিন বিরত থাকলে মস্তিষ্কের আনন্দ-ব্যবস্থা অনেকটাই সেরে ওঠে।") },
  ],
  vape: [
    { hours: 1 * DAYS, at: L("1 day", "১ দিন"), text: L("Nicotine levels fall; urges and irritability are strongest in the first days.", "নিকোটিনের মাত্রা কমে; প্রথম কয়েকদিন ইচ্ছে আর খিটখিটে ভাব সবচেয়ে বেশি থাকে।") },
    { hours: 3 * DAYS, at: L("3 days", "৩ দিন"), text: L("Nicotine has left your body. Cravings peak now and then start to ease.", "শরীর থেকে নিকোটিন বের হয়ে গেছে। এখন ইচ্ছে সবচেয়ে বেশি, তারপর কমতে শুরু করবে।") },
    { hours: 14 * DAYS, at: L("2–4 weeks", "২–৪ সপ্তাহ"), text: L("Breathing, coughing and throat irritation usually improve; sleep settles.", "শ্বাস, কাশি আর গলার জ্বালা সাধারণত ভালো হয়; ঘুম স্বাভাবিক হয়।") },
    { hours: 90 * DAYS, at: L("3 months", "৩ মাস"), text: L("Heart rate and blood pressure are healthier and urges are much rarer.", "হৃদস্পন্দন আর রক্তচাপ ভালো থাকে, ইচ্ছে অনেক কম আসে।") },
  ],
  hallucinogen: [
    { hours: 1 * DAYS, at: L("Week 1", "১ম সপ্তাহ"), text: L("Tiredness, low mood and poor sleep are common. Rest and keep to a routine.", "ক্লান্তি, মন খারাপ আর ঘুমের সমস্যা স্বাভাবিক। বিশ্রাম নিন, নিয়মিত রুটিন মেনে চলুন।") },
    { hours: 14 * DAYS, at: L("Weeks 2–4", "২–৪ সপ্তাহ"), text: L("Mood, focus and sleep steadily improve.", "মন, মনোযোগ আর ঘুম ধীরে ধীরে ভালো হয়।") },
    { hours: 60 * DAYS, at: L("Months 2–3", "২–৩ মাস"), text: L("Anxiety eases; with ketamine, bladder and stomach pain often improve.", "উদ্বেগ কমে; কেটামিনের ক্ষেত্রে মূত্রথলি আর পেটের ব্যথা প্রায়ই ভালো হয়।") },
    { hours: 180 * DAYS, at: L("6 months+", "৬ মাস+"), text: L("Memory and motivation are noticeably better.", "স্মৃতিশক্তি আর আগ্রহ বেশ ভালো হয়।") },
  ],
  cannabis: [
    { hours: 1 * DAYS, at: L("Days 1–3", "১–৩ দিন"), text: L("Irritability, restlessness, low appetite and trouble sleeping may begin.", "খিটখিটে মেজাজ, অস্থিরতা, খিদে কমা আর ঘুমের সমস্যা শুরু হতে পারে।") },
    { hours: 2 * DAYS, at: L("Days 2–6", "২–৬ দিন"), text: L("Withdrawal peaks; vivid dreams are common. It passes.", "উইথড্রয়াল সবচেয়ে বেশি থাকে; স্পষ্ট স্বপ্ন দেখা স্বাভাবিক। এটা কেটে যাবে।") },
    { hours: 7 * DAYS, at: L("Weeks 1–2", "১–২ সপ্তাহ"), text: L("Most symptoms fade.", "বেশিরভাগ লক্ষণ কমে যায়।") },
    { hours: 21 * DAYS, at: L("Weeks 3–4", "৩–৪ সপ্তাহ"), text: L("Sleep returns to normal for most people.", "বেশিরভাগ মানুষের ঘুম স্বাভাবিক হয়ে যায়।") },
    { hours: 60 * DAYS, at: L("Months 1–3", "১–৩ মাস"), text: L("Memory, focus and motivation improve; if you smoked it, coughing eases.", "স্মৃতি, মনোযোগ আর আগ্রহ বাড়ে; ধোঁয়া হিসেবে খেলে কাশিও কমে।") },
  ],
  opioid: [
    { hours: 12 * H, at: L("First day", "প্রথম দিন"), text: L("Withdrawal begins: aches, sweating, runny nose, anxiety. A doctor can help a lot now.", "উইথড্রয়াল শুরু হয়: ব্যথা, ঘাম, নাক দিয়ে পানি, উদ্বেগ। এখন ডাক্তার অনেক সাহায্য করতে পারেন।") },
    { hours: 1 * DAYS, at: L("Days 1–3", "১–৩ দিন"), text: L("The peak: cramps, diarrhoea, gooseflesh and poor sleep. Drink plenty of fluids.", "সবচেয়ে কষ্টের সময়: পেট কামড়ানো, পাতলা পায়খানা, গায়ে কাঁটা দেওয়া, ঘুমের সমস্যা। প্রচুর পানি খান।") },
    { hours: 4 * DAYS, at: L("Days 4–7", "৪–৭ দিন"), text: L("Physical symptoms ease.", "শারীরিক লক্ষণ কমে আসে।") },
    { hours: 14 * DAYS, at: L("Weeks 2–4", "২–৪ সপ্তাহ"), text: L("Sleep, mood and energy slowly improve. Cravings can last — keep your support close.", "ঘুম, মন আর শক্তি ধীরে ধীরে ভালো হয়। ইচ্ছে থাকতে পারে—সাহায্য কাছে রাখুন।") },
    { hours: 90 * DAYS, at: L("Months 1–3+", "১–৩ মাস+"), text: L("Your body and mind keep healing. Remember: your tolerance is now low.", "শরীর আর মন সেরে উঠতে থাকে। মনে রাখুন: এখন আপনার সহনশীলতা কম।") },
  ],
  medical_taper: [
    { hours: 1 * DAYS, at: L("With your doctor", "ডাক্তারের তত্ত্বাবধানে"), text: L("Your doctor plans a slow, safe reduction. Never stop suddenly on your own.", "ডাক্তার ধীরে, নিরাপদে কমানোর পরিকল্পনা করবেন। নিজে থেকে হঠাৎ বন্ধ করবেন না।") },
    { hours: 7 * DAYS, at: L("Week 1", "১ম সপ্তাহ"), text: L("With treatment, shaking, sweating and anxiety settle.", "চিকিৎসায় কাঁপুনি, ঘাম আর উদ্বেগ কমে আসে।") },
    { hours: 21 * DAYS, at: L("Weeks 2–4", "২–৪ সপ্তাহ"), text: L("Sleep and mood improve.", "ঘুম আর মন ভালো হয়।") },
    { hours: 90 * DAYS, at: L("Months 1–3", "১–৩ মাস"), text: L("Liver, blood pressure and energy keep improving.", "লিভার, রক্তচাপ আর শক্তি ভালো হতে থাকে।") },
  ],
  inhalant: [
    { hours: 1 * DAYS, at: L("Days 1–3", "১–৩ দিন"), text: L("Headaches, irritability, poor sleep and cravings.", "মাথাব্যথা, খিটখিটে মেজাজ, ঘুমের সমস্যা আর ইচ্ছে।") },
    { hours: 7 * DAYS, at: L("Weeks 1–2", "১–২ সপ্তাহ"), text: L("Mood and appetite improve.", "মন আর খিদে ভালো হয়।") },
    { hours: 60 * DAYS, at: L("Months", "কয়েক মাস"), text: L("Memory and coordination can slowly improve. See a doctor if you had fainting or chest pain.", "স্মৃতি আর শরীরের নিয়ন্ত্রণ ধীরে ধীরে ভালো হতে পারে। অজ্ঞান হওয়া বা বুকে ব্যথা হয়ে থাকলে ডাক্তার দেখান।") },
  ],
};
const timelineFor = (substanceKey) => TIMELINES[substanceKey] || TIMELINES[safetyClassOf(substanceKey)] || TIMELINES.inhalant;

// ---------------------------------------------------------------------------
// Helplines (Bangladesh). `phone` is dialled; `display` is shown.
// ---------------------------------------------------------------------------
const HELPLINES = [
  {
    key: "emergency", phone: "999", display: "999", kind: "emergency", crisis: true,
    name: L("National Emergency Service", "জাতীয় জরুরি সেবা"),
    description: L("Police, fire service and ambulance. For overdose, chest pain, seizures or if anyone is in danger.", "পুলিশ, ফায়ার সার্ভিস ও অ্যাম্বুলেন্স। ওভারডোজ, বুকে ব্যথা, খিঁচুনি বা কারো জীবনের ঝুঁকি থাকলে।"),
    hours: L("24/7", "২৪ ঘণ্টা"),
  },
  {
    key: "kaan_pete_roi", phone: "09612119911", display: "09612-119911", kind: "mental_health", crisis: true, url: "https://kaanpeteroi.org",
    name: L("Kaan Pete Roi", "কান পেতে রই"),
    description: L("Emotional support and suicide prevention. Confidential and without judgement.", "মানসিক সহায়তা ও আত্মহত্যা প্রতিরোধ হেল্পলাইন। গোপনীয়, কোনো বিচার করা হয় না।"),
    hours: L("3 pm – 3 am, every day", "প্রতিদিন দুপুর ৩টা – রাত ৩টা"),
  },
  {
    key: "shastho_batayon", phone: "16263", display: "16263", kind: "health", crisis: false,
    name: L("Shastho Batayon", "স্বাস্থ্য বাতায়ন"),
    description: L("Government health call centre: talk to a doctor and get mental-health advice and referral.", "সরকারি স্বাস্থ্য কল সেন্টার: ডাক্তারের পরামর্শ, মানসিক স্বাস্থ্য পরামর্শ ও রেফারেল।"),
    hours: L("", ""),
  },
  {
    key: "talk_hope", phone: "+8809638881888", display: "09638-881888", kind: "mental_health", crisis: false,
    name: L("Talk Hope", "টক হোপ"),
    description: L("Mental health and suicide prevention helpline with counsellors.", "কাউন্সেলরদের সাথে মানসিক স্বাস্থ্য ও আত্মহত্যা প্রতিরোধ হেল্পলাইন।"),
    hours: L("", ""),
  },
  {
    key: "child_helpline", phone: "1098", display: "1098", kind: "youth", crisis: false,
    name: L("Child Helpline (under 18)", "শিশু হেল্পলাইন (১৮ বছরের কম)"),
    description: L("Free, confidential support for children and young people.", "শিশু ও কিশোরদের জন্য বিনামূল্যে, গোপনীয় সহায়তা।"),
    hours: L("24/7", "২৪ ঘণ্টা"),
  },
  {
    key: "dnc_ctc", phone: "", display: "", kind: "treatment", crisis: false, url: "https://ctcdnc.dhaka.gov.bd",
    name: L("Central Drug Addiction Treatment Centre, Tejgaon", "কেন্দ্রীয় মাদকাসক্তি নিরাময় কেন্দ্র, তেজগাঁও"),
    description: L("Government treatment for drug dependence (Department of Narcotics Control). See the website for contact details.", "মাদকদ্রব্য নিয়ন্ত্রণ অধিদপ্তরের সরকারি মাদকাসক্তি চিকিৎসা। যোগাযোগের তথ্য ওয়েবসাইটে দেখুন।"),
    hours: L("", ""),
  },
];

// ---------------------------------------------------------------------------
// Crisis messages (curated; never generated).
// ---------------------------------------------------------------------------
const CRISIS_MESSAGES = {
  general: L(
    "It sounds like you might be in danger right now. Please call 999 or go to the nearest hospital, and don't stay alone. Kaan Pete Roi (09612-119911, 3 pm–3 am) is there to listen.",
    "মনে হচ্ছে আপনি এখন বিপদে থাকতে পারেন। দয়া করে ৯৯৯-এ ফোন করুন বা নিকটস্থ হাসপাতালে যান, একা থাকবেন না। কান পেতে রই (০৯৬১২-১১৯৯১১, দুপুর ৩টা–রাত ৩টা) আপনার কথা শুনবে।",
  ),
  suicide: L(
    "I'm really glad you told me. You matter, and you don't have to face this alone. If you might act on these thoughts, please call 999 now or go to the nearest hospital. You can also talk to Kaan Pete Roi (09612-119911, 3 pm–3 am) — they listen without judging. Can you reach someone you trust right now?",
    "আমাকে জানানোর জন্য ধন্যবাদ। আপনি গুরুত্বপূর্ণ, আর এটা আপনাকে একা সামলাতে হবে না। যদি মনে হয় নিজের ক্ষতি করে ফেলতে পারেন, এখনই ৯৯৯-এ ফোন করুন বা নিকটস্থ হাসপাতালে যান। কান পেতে রই (০৯৬১২-১১৯৯১১, দুপুর ৩টা–রাত ৩টা)-তেও কথা বলতে পারেন—তারা বিচার না করে শোনেন। এই মুহূর্তে কি বিশ্বস্ত কাউকে পাশে ডাকতে পারবেন?",
  ),
  overdose: L(
    "This could be an overdose — please call 999 now. Don't take anything else and don't stay alone. If someone is unconscious, lay them on their side and check their breathing until help arrives.",
    "এটা ওভারডোজ হতে পারে—এখনই ৯৯৯-এ ফোন করুন। আর কিছু নেবেন না, একা থাকবেন না। কেউ অজ্ঞান হলে তাকে এক পাশে কাত করে শুইয়ে দিন এবং সাহায্য না আসা পর্যন্ত শ্বাস চলছে কিনা দেখুন।",
  ),
  medical: L(
    "These can be signs of a medical emergency. Please call 999 or go to the nearest hospital now, and tell them what you took and when. Don't stay alone.",
    "এগুলো জরুরি চিকিৎসার লক্ষণ হতে পারে। এখনই ৯৯৯-এ ফোন করুন বা নিকটস্থ হাসপাতালে যান, আর কী নিয়েছেন ও কখন—তা জানান। একা থাকবেন না।",
  ),
  psychosis: L(
    "What you're going through sounds really frightening. Stimulants and lack of sleep can cause this. Please go somewhere safe, stay with someone you trust and get medical help — call 999 if you or anyone else is in danger.",
    "আপনি যা অনুভব করছেন তা সত্যিই ভয়ের। উত্তেজক মাদক আর ঘুমের অভাবে এমন হতে পারে। নিরাপদ জায়গায় যান, বিশ্বস্ত কারো সাথে থাকুন এবং চিকিৎসা নিন—আপনার বা কারো বিপদ মনে হলে ৯৯৯-এ ফোন করুন।",
  ),
  violence: L(
    "It sounds like things are very intense right now. Please step away from the situation and anyone you might hurt, and give it time. Call 999 if anyone is in danger. Kaan Pete Roi (09612-119911) can talk it through with you.",
    "মনে হচ্ছে এখন পরিস্থিতি খুব উত্তপ্ত। দয়া করে ঘটনাস্থল আর যাকে আঘাত করতে পারেন তার কাছ থেকে সরে যান, একটু সময় নিন। কারো বিপদ হলে ৯৯৯-এ ফোন করুন। কান পেতে রই (০৯৬১২-১১৯৯১১)-তে কথা বলতে পারেন।",
  ),
};

// ---------------------------------------------------------------------------
// Curated fallbacks used whenever AI is off, slow, blocked or invalid.
// ---------------------------------------------------------------------------
const COACH_FALLBACKS = {
  coach: L(
    "I can't reach Sathi right now, but your tools still work: SOS for cravings, your reasons, and the Help page. Please try me again in a moment.",
    "এই মুহূর্তে সাথীর সাথে যোগাযোগ হচ্ছে না, তবে আপনার টুলগুলো কাজ করছে: ইচ্ছে জাগলে SOS, আপনার কারণগুলো আর সাহায্য পেজ। একটু পরে আবার চেষ্টা করুন।",
  ),
  sos: L(
    "You can get through this. Breathe in slowly for 4, hold for 4, breathe out for 4. The craving will rise, peak and pass — let's ride it out with the urge timer.",
    "আপনি পারবেন। ধীরে ৪ গুনে শ্বাস নিন, ৪ গুনে ধরে রাখুন, ৪ গুনে ছাড়ুন। ইচ্ছেটা বাড়বে, চূড়ায় উঠবে, তারপর কমে যাবে—চলুন টাইমার দিয়ে একসাথে পার করি।",
  ),
  lapse: L(
    "A slip doesn't erase your progress. What matters most is the next hour: drink some water, rest, and when you're ready, let's look at what led to it.",
    "একবার ভুল হলে আপনার অগ্রগতি মুছে যায় না। সবচেয়ে গুরুত্বপূর্ণ হলো পরের এক ঘণ্টা: একটু পানি খান, বিশ্রাম নিন, আর প্রস্তুত হলে দেখি কী কারণে এমন হলো।",
  ),
  refusal: L(
    "I want to keep you safe, so I can't help with that. I'm here for your recovery — would you like to try a craving tool, or talk about what's going on?",
    "আপনাকে নিরাপদ রাখতে চাই, তাই এ বিষয়ে সাহায্য করতে পারছি না। আমি আপনার সুস্থ হওয়ার পথে পাশে আছি—একটা টুল চেষ্টা করবেন, নাকি কী হচ্ছে তা নিয়ে কথা বলবেন?",
  ),
};

const DAILY_NOTES = [
  { note: L("Cravings are like waves: they rise, peak and fall. You don't have to act on them.", "ইচ্ছেগুলো ঢেউয়ের মতো: ওঠে, চূড়ায় পৌঁছায়, তারপর নেমে যায়। এর কথামতো কাজ করতে হবে না।"), mission: L("Drink 8 glasses of water today.", "আজ ৮ গ্লাস পানি পান করুন।") },
  { note: L("Every day you stay stopped, your brain rebuilds a little more.", "যতদিন বিরত থাকছেন, আপনার মস্তিষ্ক একটু একটু করে আবার সুস্থ হচ্ছে।"), mission: L("Take a 10-minute walk after a meal.", "খাওয়ার পর ১০ মিনিট হাঁটুন।") },
  { note: L("You don't have to do this alone. Letting one person in makes it lighter.", "এটা একা করতে হবে না। একজনকে পাশে রাখলে ভার অনেক হালকা হয়।"), mission: L("Call or message your support person.", "আপনার সাপোর্ট পার্সনকে ফোন বা মেসেজ করুন।") },
  { note: L("HALT: when you're Hungry, Angry, Lonely or Tired, cravings get louder. Check in with yourself.", "HALT: ক্ষুধা, রাগ, একাকীত্ব বা ক্লান্তিতে ইচ্ছে বাড়ে। নিজের খোঁজ নিন।"), mission: L("Eat proper meals at regular times.", "সময়মতো ঠিকমতো খাবার খান।") },
  { note: L("Slips don't erase progress. Learning from them builds it.", "একবার ভুল হলে অগ্রগতি মুছে যায় না—শিক্ষা নিলে আরও বাড়ে।"), mission: L("Write down one trigger and your plan for it.", "একটা ট্রিগার আর তার জন্য আপনার পরিকল্পনা লিখে রাখুন।") },
  { note: L("Sleep is medicine in recovery. Protect it.", "সুস্থ হওয়ার পথে ঘুমই ওষুধ। ঘুমকে গুরুত্ব দিন।"), mission: L("Put the phone away 30 minutes before bed.", "ঘুমের ৩০ মিনিট আগে ফোন রেখে দিন।") },
  { note: L("Your reasons are stronger than any craving. Read them today.", "আপনার কারণগুলো যেকোনো ইচ্ছের চেয়ে শক্তিশালী। আজ সেগুলো পড়ুন।"), mission: L("Read your reasons once in the morning and once at night.", "সকালে একবার আর রাতে একবার আপনার কারণগুলো পড়ুন।") },
  { note: L("Moving your body lowers stress and cravings.", "শরীর নাড়ালে চাপ আর ইচ্ছে দুটোই কমে।"), mission: L("Do 15 minutes of any exercise or sport.", "১৫ মিনিট যেকোনো ব্যায়াম বা খেলাধুলা করুন।") },
  { note: L("Avoiding a risky place isn't weakness — it's a smart plan.", "ঝুঁকির জায়গা এড়ানো দুর্বলতা নয়—এটা বুদ্ধিমানের পরিকল্পনা।"), mission: L("Take a different route past your usual risky spot.", "চেনা ঝুঁকির জায়গাটা এড়িয়ে অন্য পথে যান।") },
  { note: L("Money you don't spend on drugs is money for your dreams.", "মাদকে যে টাকা খরচ হচ্ছে না, সেটা আপনার স্বপ্নের জন্য।"), mission: L("Put today's saved money aside for your reward.", "আজকের বাঁচানো টাকা আপনার পুরস্কারের জন্য আলাদা রাখুন।") },
  { note: L("You've survived every craving so far. This one will pass too.", "এখন পর্যন্ত প্রতিটা ইচ্ছেকে আপনি পার করেছেন। এটাও চলে যাবে।"), mission: L("Use the SOS tool once today, even for a small urge.", "ছোট ইচ্ছে হলেও আজ একবার SOS টুল ব্যবহার করুন।") },
  { note: L("Being kind to yourself makes change easier than shame does.", "লজ্জার চেয়ে নিজের প্রতি সদয় হওয়া পরিবর্তনকে সহজ করে।"), mission: L("Write down one thing you did well today.", "আজ ভালো করেছেন এমন একটা কাজ লিখে রাখুন।") },
  { note: L("Plan your 'no' in advance: short, clear, and then leave.", "'না' বলাটা আগে থেকে ঠিক করে রাখুন: ছোট, পরিষ্কার—তারপর সরে যান।"), mission: L("Say your refusal line out loud 3 times.", "আপনার 'না' বলার লাইনটা ৩ বার জোরে বলে অনুশীলন করুন।") },
  { note: L("Breathing slowly tells your body it is safe.", "ধীরে শ্বাস নিলে শরীর বোঝে সে নিরাপদ।"), mission: L("Do 4-4-4-4 breathing for 2 minutes.", "২ মিনিট ৪-৪-৪-৪ শ্বাসের ব্যায়াম করুন।") },
];

const CHECKIN_FALLBACKS = {
  used: { reflection: L("Thank you for being honest. One day doesn't define you — tomorrow is a fresh start. Tonight, rest and drink water.", "সততার জন্য ধন্যবাদ। একটা দিন আপনাকে সংজ্ঞায়িত করে না—কাল নতুন শুরু। আজ রাতে বিশ্রাম নিন, পানি খান।"), microGoal: L("Tomorrow: plan what you'll do at the time the urge came today.", "কাল: আজ যে সময়ে ইচ্ছে জেগেছিল, সে সময়ে কী করবেন তা ঠিক করুন।") },
  highCraving: { reflection: L("Strong cravings today, and you still checked in — that's real effort. Keep SOS close tonight.", "আজ ইচ্ছে বেশ তীব্র ছিল, তবুও চেক-ইন করেছেন—এটা সত্যিকারের চেষ্টা। আজ রাতে SOS হাতের কাছে রাখুন।"), microGoal: L("Tomorrow: use SOS the moment an urge starts.", "কাল: ইচ্ছে শুরু হওয়ার সাথে সাথে SOS খুলুন।") },
  lowMood: { reflection: L("Low days happen, especially early on. Reach out to someone today — you don't have to carry it alone.", "শুরুর দিকে মন খারাপের দিন আসে। আজ কারো সাথে কথা বলুন—একা বয়ে বেড়াতে হবে না।"), microGoal: L("Tomorrow: do one small thing you enjoy and tell someone how you feel.", "কাল: পছন্দের ছোট একটা কাজ করুন আর কাউকে জানান আপনি কেমন আছেন।") },
  good: { reflection: L("Another day stronger. Notice what helped today and do it again tomorrow.", "আরও একটা দিন শক্ত থাকলেন। আজ কী কাজে দিয়েছে খেয়াল করুন, কালও সেটা করুন।"), microGoal: L("Tomorrow: repeat what worked today.", "কাল: আজ যা কাজে দিয়েছে তা আবার করুন।") },
};

const LAPSE_FALLBACK = {
  reflection: L("A slip is information, not failure. You're here, you're honest, and that's how recovery keeps going.", "একবার ভুল হওয়া ব্যর্থতা নয়, শিক্ষা। আপনি এখানে আছেন, সৎ আছেন—এভাবেই সুস্থ হওয়ার পথ চলতে থাকে।"),
  lesson: L("Notice the very first moment the urge started — that's where your plan should step in next time.", "ইচ্ছেটা ঠিক কোন মুহূর্তে শুরু হয়েছিল খেয়াল করুন—পরেরবার ঠিক সেখানেই আপনার পরিকল্পনা কাজে লাগাতে হবে।"),
  action: L("I will open SOS and call my support person before deciding anything.", "কিছু সিদ্ধান্ত নেওয়ার আগে আমি SOS খুলব আর আমার সাপোর্ট পার্সনকে ফোন করব।"),
};

const CHECKLIST = {
  common: [
    L("Delete dealer and using-friend numbers", "ডিলার ও একসাথে নেশা করা বন্ধুদের নম্বর মুছে ফেলুন"),
    L("Throw away lighters, foil, papers and pipes", "লাইটার, ফয়েল, কাগজ আর পাইপ ফেলে দিন"),
    L("Change your route to avoid risky spots", "ঝুঁকির জায়গা এড়াতে যাতায়াতের পথ বদলান"),
    L("Don't carry extra cash", "বাড়তি টাকা সাথে রাখবেন না"),
    L("Tell one trusted person about your plan", "একজন বিশ্বস্ত মানুষকে আপনার পরিকল্পনার কথা জানান"),
    L("Decide what you'll do at your riskiest time of day", "দিনের সবচেয়ে ঝুঁকির সময়ে কী করবেন ঠিক করুন"),
  ],
  nicotine: [L("Ask a doctor or pharmacist about nicotine gum or patches", "নিকোটিন গাম বা প্যাচ নিয়ে ডাক্তার বা ফার্মাসিস্টকে জিজ্ঞেস করুন")],
  cannabis: [L("Plan a calming bedtime routine for the first two weeks", "প্রথম দুই সপ্তাহের জন্য ঘুমের আগের শান্ত একটা রুটিন ঠিক করুন")],
  stimulant: [L("Stock easy food and water at home for the first 3 days", "প্রথম ৩ দিনের জন্য বাসায় সহজ খাবার আর পানি রাখুন")],
  opioid: [L("Book a visit with a doctor or treatment centre for withdrawal support", "উইথড্রয়ালের সহায়তার জন্য ডাক্তার বা চিকিৎসা কেন্দ্রে যাওয়ার সময় ঠিক করুন")],
  medical_taper: [L("See a doctor before cutting down — plan a safe, slow reduction", "কমানোর আগে ডাক্তার দেখান—নিরাপদে ধীরে কমানোর পরিকল্পনা করুন")],
  inhalant: [L("Stay close to people who support you", "যারা সাহায্য করে তাদের কাছাকাছি থাকুন")],
  other: [L("Ask a doctor whether it's safe to stop suddenly", "হঠাৎ বন্ধ করা নিরাপদ কিনা ডাক্তারকে জিজ্ঞেস করুন")],
};

const WEEKLY_GOALS = [
  { week: 1, goal: L("Get through each craving with SOS and check in every day.", "প্রতিটা ইচ্ছে SOS দিয়ে পার করুন আর প্রতিদিন চেক-ইন করুন।") },
  { week: 2, goal: L("Use your if-then plans for your top two triggers.", "আপনার প্রধান দুটি ট্রিগারের জন্য 'যদি-তাহলে' পরিকল্পনা কাজে লাগান।") },
  { week: 3, goal: L("Build a new routine for your riskiest time of day.", "দিনের সবচেয়ে ঝুঁকির সময়ের জন্য নতুন রুটিন তৈরি করুন।") },
  { week: 4, goal: L("Celebrate one month and set your next reward goal.", "এক মাস উদযাপন করুন আর পরের পুরস্কারের লক্ষ্য ঠিক করুন।") },
];

const PLAN_SUMMARY = L(
  "Your plan focuses on getting through cravings one at a time, handling your main triggers with ready-made actions, and building each day on the last.",
  "আপনার পরিকল্পনার মূল কথা: একটা একটা করে ইচ্ছে পার করা, প্রধান ট্রিগারগুলোর জন্য আগে থেকে ঠিক করা কাজ, আর প্রতিটা দিনের ওপর পরের দিন গড়ে তোলা।",
);
const REWARD_IDEA = L(
  "Put the money you save aside every week and choose something meaningful to buy with it at one month.",
  "প্রতি সপ্তাহে বাঁচানো টাকা আলাদা রাখুন, আর এক মাস পূর্ণ হলে তা দিয়ে অর্থবহ কিছু কিনুন।",
);

module.exports = {
  L,
  normalizeLang,
  localize,
  fill,
  SAFETY_CLASSES,
  SUBSTANCES,
  SUBSTANCE_KEYS,
  substanceMeta,
  safetyClassOf,
  SCREENERS,
  TRIGGERS,
  TRIGGER_KEYS,
  REASONS,
  REASON_KEYS,
  HALT,
  HALT_KEYS,
  BACKGROUND,
  BACKGROUND_MULTI,
  BACKGROUND_SINGLE,
  backgroundKeys,
  BACKGROUND_SAFETY,
  BACKGROUND_CHECKLIST,
  WARNING_SIGNS,
  SYMPTOMS,
  SYMPTOM_KEYS,
  TOOL_KEYS,
  SUGGESTED_TOOL_KEYS,
  MILESTONES,
  BADGES,
  POINTS,
  TIMELINES,
  timelineFor,
  HELPLINES,
  CRISIS_MESSAGES,
  COACH_FALLBACKS,
  DAILY_NOTES,
  CHECKIN_FALLBACKS,
  LAPSE_FALLBACK,
  CHECKLIST,
  WEEKLY_GOALS,
  PLAN_SUMMARY,
  REWARD_IDEA,
};
