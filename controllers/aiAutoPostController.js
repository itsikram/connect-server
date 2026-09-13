const AIAutoPostConfig = require("../models/AIAutoPostConfig");
const AIGeneratedPost = require("../models/AIGeneratedPost");
const Post = require("../models/Post");
const Profile = require("../models/Profile");
const { getConfig, normalizeConfig, generateAutoPost } = require("../services/aiAutoPostService");

const publicError = (error) => String(error?.message || "AI auto-post request failed").slice(0, 300);

exports.getConfig = async (req, res, next) => {
  try { return res.json(await getConfig()); } catch (error) { return next(error); }
};

exports.searchAuthorProfiles = async (req, res, next) => {
  try {
    const query = String(req.query.q || "").trim();
    const ids = String(req.query.ids || "").split(",").filter((id) => /^[a-f\d]{24}$/i.test(id)).slice(0, 50);
    if (query.length < 2 && !ids.length) return res.json([]);
    const filter = ids.length
      ? { _id: { $in: ids } }
      : { $or: [{ username: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { fullName: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { displayName: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { nickname: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }] };
    const profiles = await Profile.find(filter).select("_id username fullName displayName nickname profilePic isOfficial isVerified").sort({ fullName: 1 }).limit(20).lean();
    return res.json(profiles);
  } catch (error) { return next(error); }
};

exports.updateConfig = async (req, res, next) => {
  try {
    const nextConfig = normalizeConfig(req.body || {});
    const saved = await AIAutoPostConfig.findOneAndUpdate(
      { singletonKey: "default" },
      { $set: { ...nextConfig, updatedBy: req.admin._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return res.json(normalizeConfig(saved));
  } catch (error) { return next(error); }
};

exports.generateNow = async (req, res) => {
  try {
    const config = normalizeConfig(req.body?.config || await getConfig());
    const generated = await generateAutoPost({ config, publish: Boolean(req.body?.publish) });
    return res.status(201).json(generated);
  } catch (error) {
    console.error("[ai-auto-post] manual generation failed:", error?.message || error);
    return res.status(error.status || 502).json({ message: publicError(error) });
  }
};

exports.listHistory = async (req, res, next) => {
  try {
    const query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.category) query.category = String(req.query.category).toLowerCase();
    if (req.query.language) query.language = req.query.language;
    if (req.query.topic) query.topic = new RegExp(String(req.query.topic).slice(0, 80), "i");
    const items = await AIGeneratedPost.find(query).sort({ generatedAt: -1 }).limit(100).lean();
    return res.json(items);
  } catch (error) { return next(error); }
};

exports.publish = async (req, res) => {
  try {
    const item = await AIGeneratedPost.findById(req.params.id);
    if (!item || item.status === "deleted") return res.status(404).json({ message: "Generated post not found" });
    if (item.status === "published") return res.json(item);
    const post = await Post.create({ caption: `${item.caption}${item.hashtags.length ? `\n\n${item.hashtags.map((tag) => `#${tag}`).join(" ")}` : ""}`, photos: item.imageUrl || undefined, author: item.author, audience: 1, source: "ai-auto-post", type: item.imageUrl ? "image" : "post", aiMetadata: { status: "ready", categories: [item.category], provider: item.provider, processedAt: new Date() } });
    item.post = post._id; item.status = "published"; item.publishedAt = new Date(); await item.save();
    return res.json(item);
  } catch (error) { return res.status(502).json({ message: publicError(error) }); }
};

exports.updateGenerated = async (req, res) => {
  const item = await AIGeneratedPost.findByIdAndUpdate(req.params.id, { $set: { caption: String(req.body?.caption || "").trim().slice(0, 500), hashtags: Array.isArray(req.body?.hashtags) ? req.body.hashtags.slice(0, 8) : undefined } }, { new: true, runValidators: true });
  if (!item) return res.status(404).json({ message: "Generated post not found" });
  if (item.post) {
    await Post.findByIdAndUpdate(item.post, {
      $set: { caption: `${item.caption}${item.hashtags.length ? `\n\n${item.hashtags.map((tag) => `#${tag}`).join(" ")}` : ""}` },
    });
  }
  return res.json(item);
};

exports.deleteGenerated = async (req, res) => {
  const item = await AIGeneratedPost.findByIdAndUpdate(req.params.id, { $set: { status: "deleted" } }, { new: true });
  if (!item) return res.status(404).json({ message: "Generated post not found" });
  if (item.post) await Post.findByIdAndDelete(item.post);
  return res.json({ ok: true });
};

exports.regenerate = async (req, res) => {
  try { return res.status(201).json(await generateAutoPost({ config: await getConfig(), publish: false })); } catch (error) { return res.status(502).json({ message: publicError(error) }); }
};

exports.setPaused = async (req, res, next) => {
  try {
    const paused = Boolean(req.body?.paused);
    await AIAutoPostConfig.findOneAndUpdate({ singletonKey: "default" }, { $set: { paused } }, { upsert: true });
    return res.json({ paused });
  } catch (error) { return next(error); }
};
