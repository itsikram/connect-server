const Post = require("../models/Post");
const Profile = require("../models/Profile");
const Message = require("../models/Message");
const { ensureOfficialAccount } = require("./connectOfficialAccount");

const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

const MORNING_PROMPTS = [
  "What's one good thing that happened today?\nআজকের একটা ভালো খবর কী?",
  "Drop a photo of what you're eating.\nএখন যা খাচ্ছো তার একটা ছবি দাও।",
  "What song is stuck in your head?\nমাথায় কোন গান ঘুরছে?",
  "One thing you're grateful for right now.\nএই মুহূর্তে কিসের জন্য কৃতজ্ঞ?",
  "What are you learning this week?\nএই সপ্তাহে কী শিখছো?",
  "Share a win, even a tiny one.\nএকটা জয় শেয়ার করো, ছোট হলেও চলবে।",
  "Who made you smile today?\nআজ কে তোমাকে হাসিয়েছে?",
];

const EVENING_PROMPTS = [
  "Photo of the day — what did you see?\nআজকের ছবি — কী দেখলে?",
  "Challenge a friend to Ludo or Chess tonight.\nআজ রাতে কাউকে লুডু বা দাবায় চ্যালেঞ্জ করো।",
  "How did today actually go?\nআজকের দিনটা আসলে কেমন কাটল?",
  "One thing you'll do better tomorrow.\nকালকে একটা জিনিস ভালো করবে।",
  "Caption this: your current mood.\nএখনকার মুডটা ক্যাপশন করো।",
];

let workerInterval = null;
let isRunning = false;

const bdNow = () => new Date(Date.now() + BD_OFFSET_MS);

const bdDayStartUtc = () => {
  const now = bdNow();
  const startBd = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  return new Date(startBd - BD_OFFSET_MS);
};

const pickPrompt = (list) => {
  const day = Math.floor(
    (bdNow() - Date.UTC(bdNow().getUTCFullYear(), 0, 0)) / 86400000,
  );
  return list[Math.abs(day) % list.length];
};

const alreadyPosted = async (authorId, source, since) => {
  const existing = await Post.findOne({
    author: authorId,
    source,
    createdAt: { $gte: since },
  }).select("_id");
  return Boolean(existing);
};

const createOfficialPost = async (profile, caption, source) => {
  await Post.create({
    caption: String(caption).slice(0, 500),
    author: profile._id,
    audience: 1,
    source,
    type: "post",
  });
  console.log(`[connect-prompts] posted ${source}`);
};

const sendWeeklyRecaps = async (officialProfile) => {
  const now = bdNow();
  if (now.getUTCDay() !== 0 || now.getUTCHours() < 9) return;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recapCutoff = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

  const authors = await Post.distinct("author", { createdAt: { $gte: weekAgo } });
  const targets = await Profile.find({
    _id: { $in: authors, $ne: officialProfile._id },
    isOfficial: { $ne: true },
    $or: [
      { lastWeeklyRecapAt: { $exists: false } },
      { lastWeeklyRecapAt: null },
      { lastWeeklyRecapAt: { $lt: recapCutoff } },
    ],
  }).limit(40);

  for (const profile of targets) {
    const posts = await Post.find({
      author: profile._id,
      createdAt: { $gte: weekAgo },
    }).select("reacts comments");
    const reacts = posts.reduce((n, p) => n + (p.reacts?.length || 0), 0);
    const comments = posts.reduce((n, p) => n + (p.comments?.length || 0), 0);
    const text = `Your week on Connect: ${posts.length} post${posts.length === 1 ? "" : "s"}, ${reacts} reacts, ${comments} comments. Want to share a highlight? Open Home and tap Share a highlight.`;
    const room = [String(officialProfile._id), String(profile._id)].sort().join("_");
    await Message.create({
      room,
      senderId: String(officialProfile._id),
      receiverId: String(profile._id),
      message: text,
      messageType: "text",
    });
    profile.lastWeeklyRecapAt = new Date();
    await profile.save();
  }

  if (targets.length) {
    console.log(`[connect-prompts] sent ${targets.length} weekly recap messages`);
  }
};

const tick = async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    const official = await ensureOfficialAccount();
    if (!official?._id) return;

    const hour = bdNow().getUTCHours();
    const dayStart = bdDayStartUtc();

    if (hour >= 7 && hour < 11) {
      if (!(await alreadyPosted(official._id, "official-morning", dayStart))) {
        await createOfficialPost(
          official,
          pickPrompt(MORNING_PROMPTS),
          "official-morning",
        );
      }
    }

    if (hour >= 18 && hour < 22) {
      if (!(await alreadyPosted(official._id, "official-evening", dayStart))) {
        await createOfficialPost(
          official,
          pickPrompt(EVENING_PROMPTS),
          "official-evening",
        );
      }
    }

    await sendWeeklyRecaps(official);
  } catch (error) {
    console.error("[connect-prompts] tick failed:", error?.message || error);
  } finally {
    isRunning = false;
  }
};

const startDailyPromptWorker = () => {
  if (workerInterval) return;
  tick();
  workerInterval = setInterval(tick, INTERVAL_MS);
  if (typeof workerInterval.unref === "function") workerInterval.unref();
};

module.exports = {
  startDailyPromptWorker,
};
