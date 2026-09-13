const crypto = require("crypto");
const Post = require("../models/Post");
const Profile = require("../models/Profile");
const UserInterestProfile = require("../models/UserInterestProfile");
const AIAutoPostConfig = require("../models/AIAutoPostConfig");
const AIGeneratedPost = require("../models/AIGeneratedPost");
const { ensureOfficialAccount } = require("../utils/connectOfficialAccount");
const { getProviderKey, loadAiSettings } = require("../utils/aiSettingsStore");
const { generateImage } = require("./imageGenerationService");
const { Types } = require("mongoose");

const DEFAULT_CATEGORIES = ["technology", "ai", "programming", "business", "education", "lifestyle"];
const DEFAULT_TYPES = ["educational", "discussion", "funny", "tip", "industry-insight"];

const splitList = (value) =>
  (Array.isArray(value) ? value : String(value || "").split(/[,\n]/))
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 50);

const normalizeConfig = (input = {}) => ({
  enabled: Boolean(input.enabled),
  categories: splitList(input.categories).length ? splitList(input.categories) : DEFAULT_CATEGORIES,
  customCategories: splitList(input.customCategories),
  authorProfiles: (Array.isArray(input.authorProfiles) ? input.authorProfiles : [])
    .map((id) => String(id))
    .filter((id) => Types.ObjectId.isValid(id))
    .slice(0, 50),
  topics: splitList(input.topics),
  keywords: splitList(input.keywords),
  excludedTopics: splitList(input.excludedTopics),
  contentThemes: splitList(input.contentThemes),
  customInstructions: String(input.customInstructions || "").slice(0, 2000),
  language: String(input.language || "English").slice(0, 40),
  customLanguage: String(input.customLanguage || "").slice(0, 40),
  tone: String(input.tone || "natural").slice(0, 40),
  contentTypes: splitList(input.contentTypes).length ? splitList(input.contentTypes) : DEFAULT_TYPES,
  useUserPreferences: input.useUserPreferences !== false,
  useEngagementSignals: input.useEngagementSignals !== false,
  useRecentTrends: input.useRecentTrends !== false,
  imageEnabled: input.imageEnabled !== false,
  imageProvider: String(input.imageProvider || "configured").slice(0, 40),
  imageStyle: String(input.imageStyle || "clean editorial illustration").slice(0, 120),
  includeHashtags: input.includeHashtags !== false,
  maxHashtags: Math.min(8, Math.max(0, Number(input.maxHashtags) || 4)),
  postsPerDay: Math.min(10, Math.max(1, Number(input.postsPerDay) || 1)),
  schedule: (Array.isArray(input.schedule) ? input.schedule : ["09:00"])
    .filter((time) => /^\d{2}:\d{2}$/.test(String(time)) && Number(time.slice(0, 2)) < 24 && Number(time.slice(3)) < 60)
    .slice(0, 10),
  timezone: String(input.timezone || "UTC").slice(0, 60),
  autoPublish: Boolean(input.autoPublish),
  paused: Boolean(input.paused),
  maxAttemptsPerRun: Math.min(3, Math.max(1, Number(input.maxAttemptsPerRun) || 2)),
  provider: "gemini",
  model: String(input.model || "").slice(0, 100),
});

const getConfig = async () => {
  const existing = await AIAutoPostConfig.findOne({ singletonKey: "default" }).lean();
  return normalizeConfig(existing || {});
};

const getPersonalizationContext = async (config) => {
  const context = { preferredCategories: [], preferredTopics: [], recentTopics: [], previousTopics: [] };
  if (config.useUserPreferences || config.useEngagementSignals) {
    const interest = await UserInterestProfile.findOne().sort({ interactionCount: -1, updatedAt: -1 }).lean();
    context.preferredCategories = Object.entries(interest?.categories || {})
      .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8).map(([name]) => name);
  }
  if (config.useRecentTrends) {
    const recent = await Post.find({ source: { $ne: "ai-auto-post" }, createdAt: { $gte: new Date(Date.now() - 14 * 86400000) } })
      .select("caption aiMetadata.categories").sort({ createdAt: -1 }).limit(30).lean();
    context.recentTopics = recent.flatMap((item) => item.aiMetadata?.categories || []).map(String).slice(0, 12);
  }
  context.previousTopics = await AIGeneratedPost.find({ status: { $ne: "deleted" } })
    .sort({ generatedAt: -1 }).limit(30).select("topic").lean().then((items) => items.map((item) => item.topic));
  return context;
};

const buildPostGenerationPrompt = ({ config, context, category, contentType }) => {
  const language = config.language.trim().toLowerCase() === "custom"
    ? config.customLanguage || "the requested custom language"
    : config.language;
  const prompt = `Create one polished, original Connect social post.
Return ONLY JSON: {"topic":"","caption":"","hashtags":[],"contentType":"","imagePrompt":""}.
Write the topic, caption, hashtags, and metadata in ${language}. Every word in the caption must be in ${language}; do not translate it to English. Tone=${config.tone} (follow this tone consistently); category=${category}; format=${contentType}.
Topics=${config.topics.slice(0, 10).join(", ") || "choose automatically"}; keywords=${config.keywords.slice(0, 10).join(", ") || "none"}; themes=${config.contentThemes.slice(0, 10).join(", ") || "none"}.
Avoid=${config.excludedTopics.slice(0, 10).join(", ") || "none"}.
Audience signals=${context.preferredCategories.slice(0, 6).join(", ") || "general"}; recent categories=${context.recentTopics.slice(0, 8).join(", ") || "none"}.
Do not repeat these topics: ${context.previousTopics.slice(0, 12).join(" | ") || "none"}.
Requirements: professional editorial quality; natural human wording; a specific hook and useful or genuinely entertaining value; no clickbait, spam, unsafe content, invented facts, or private data.
Caption 80-450 characters. Use <=${config.maxHashtags} short relevant hashtags in ${language}. Image prompt must be written in English for the image provider and describe a premium editorial photograph or polished illustration matching the topic, with composition, lighting, subject, and color palette; no text overlays, logos, watermarks, or real-person likenesses. Visual style=${config.imageStyle}.
Admin instructions=${config.customInstructions || "Vary the approach and invite healthy discussion only when natural."}`;
  return prompt;
};

const parseJson = (text) => {
  const cleaned = String(text || "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object") throw new Error("AI response was not an object");
  const caption = String(parsed.caption || "").trim();
  const topic = String(parsed.topic || "").trim();
  if (!caption || !topic || caption.length < 20 || caption.length > 500) throw new Error("AI response is missing a professional caption or topic");
  return {
    topic: topic.slice(0, 180),
    caption,
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map((tag) => String(tag).replace(/^#/, "").trim()).filter(Boolean).slice(0, 8) : [],
    contentType: String(parsed.contentType || "").slice(0, 50),
    imagePrompt: String(parsed.imagePrompt || "").slice(0, 800),
  };
};

const isDuplicate = async (caption, topic) => {
  const normalized = String(caption).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const recent = await AIGeneratedPost.find({ status: { $ne: "deleted" }, generatedAt: { $gte: new Date(Date.now() - 30 * 86400000) } })
    .select("caption topic").lean();
  return recent.some((item) => item.topic.toLowerCase() === topic.toLowerCase() ||
    item.caption.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === normalized);
};

const generateAutoPost = async ({ config: rawConfig, publish = false, adminId = null } = {}) => {
  const config = normalizeConfig(rawConfig || await getConfig());
  const configuredAuthors = config.authorProfiles.length
    ? await Profile.find({ _id: { $in: config.authorProfiles } })
      .select("_id")
      .lean()
    : [];
  const authorPool = configuredAuthors.length ? configuredAuthors : [await ensureOfficialAccount()];
  const author = authorPool[Math.floor(Math.random() * authorPool.length)];
  const context = await getPersonalizationContext(config);
  const category = [...config.categories, ...config.customCategories][Math.floor(Math.random() * Math.max(1, config.categories.length + config.customCategories.length))] || "technology";
  const contentType = config.contentTypes[Math.floor(Math.random() * config.contentTypes.length)] || "educational";
  const settings = await loadAiSettings();
  const provider = settings.defaultProvider === "gemini" ? "gemini" : "gemini";
  const model = config.model || settings.models?.gemini || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const key = await getProviderKey(provider);
  if (!key) throw new Error("Gemini is not configured on the server");
  const { completeGemini } = require("../controllers/aiCompleteController");
  let generated;
  let lastError;
  for (let attempt = 0; attempt < config.maxAttemptsPerRun; attempt += 1) {
    try {
      const text = await completeGemini({
        apiKey: key,
        model,
        system: "You are a professional social editor. Return complete JSON only. Never reveal private user data.",
        messages: [{ role: "user", content: buildPostGenerationPrompt({ config, context, category, contentType }) }],
        json: true,
        temperature: 0.65,
        maxTokens: 700,
      });
      const candidate = parseJson(text);
      if (await isDuplicate(candidate.caption, candidate.topic)) throw new Error("Generated content duplicates a recent AI post");
      generated = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!generated) throw lastError || new Error("AI did not produce a valid post");
  let image = { imageUrl: "", provider: "none", status: config.imageEnabled ? "failed" : "disabled", error: "" };
  if (config.imageEnabled) {
    try {
      const generatedImage = await generateImage({ prompt: generated.imagePrompt, provider: config.imageProvider });
      image = { ...generatedImage, status: generatedImage.imageUrl ? "ready" : "failed", error: "" };
    } catch (error) {
      console.warn("[ai-auto-post] image generation failed:", error?.message || error);
      image.error = "Image generation failed; the post was saved without media.";
    }
  }
  const hashtags = config.includeHashtags ? generated.hashtags.slice(0, config.maxHashtags) : [];
  const record = await AIGeneratedPost.create({
    author: author._id,
    category,
    topic: generated.topic,
    language: config.language === "Custom" ? config.customLanguage : config.language,
    contentType: generated.contentType || contentType,
    caption: generated.caption,
    hashtags,
    imagePrompt: generated.imagePrompt,
    imageUrl: image.imageUrl,
    imageStatus: image.status,
    imageError: image.error || undefined,
    provider,
    model,
    personalization: { categories: context.preferredCategories, topics: context.previousTopics.slice(0, 8) },
    status: publish || config.autoPublish ? "published" : "draft",
    publishedAt: publish || config.autoPublish ? new Date() : undefined,
  });
  if (record.status === "published") {
    const post = await Post.create({
      caption: `${generated.caption}${hashtags.length ? `\n\n${hashtags.map((tag) => `#${tag}`).join(" ")}` : ""}`,
      photos: image.imageUrl || undefined,
      author: author._id,
      audience: 1,
      source: "ai-auto-post",
      type: image.imageUrl ? "image" : "post",
      aiMetadata: { status: "ready", categories: [category], provider, contentHash: crypto.createHash("sha256").update(generated.caption).digest("hex"), processedAt: new Date() },
    });
    record.post = post._id;
    await record.save();
  }
  return record.toObject();
};

module.exports = {
  getConfig,
  normalizeConfig,
  getPersonalizationContext,
  buildPostGenerationPrompt,
  generateAutoPost,
};
