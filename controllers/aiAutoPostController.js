const { prisma, isValidId, jsonArray } = require("../utils/db");
const { getConfig, normalizeConfig, generateAutoPost, buildAiPostData } = require("../services/aiAutoPostService");

const publicError = (error) => String(error?.message || "AI auto-post request failed").slice(0, 300);
const withHashtags = (item) => item && { ...item, hashtags: jsonArray(item.hashtags) };
const captionWithTags = (item) =>
  `${item.caption}${item.hashtags.length ? `\n\n${item.hashtags.map((tag) => `#${tag}`).join(" ")}` : ""}`;
const findGenerated = async (id) =>
  isValidId(id) ? withHashtags(await prisma.aIGeneratedPost.findUnique({ where: { id } })) : null;

exports.getConfig = async (req, res, next) => {
  try { return res.json(await getConfig()); } catch (error) { return next(error); }
};

exports.searchAuthorProfiles = async (req, res, next) => {
  try {
    const query = String(req.query.q || "").trim();
    const ids = String(req.query.ids || "").split(",").filter((id) => /^[a-f\d]{24}$/i.test(id)).slice(0, 50);
    if (query.length < 2 && !ids.length) return res.json([]);
    const where = ids.length
      ? { id: { in: ids } }
      : { OR: [{ username: { contains: query } }, { fullName: { contains: query } }, { displayName: { contains: query } }, { nickname: { contains: query } }] };
    const profiles = await prisma.profile.findMany({
      where,
      select: { id: true, username: true, fullName: true, displayName: true, nickname: true, profilePic: true, isOfficial: true, isVerified: true },
      orderBy: { fullName: "asc" },
      take: 20,
    });
    return res.json(profiles);
  } catch (error) { return next(error); }
};

exports.updateConfig = async (req, res, next) => {
  try {
    const data = { ...normalizeConfig(req.body || {}), updatedBy: String(req.admin._id) };
    const saved = await prisma.aIAutoPostConfig.upsert({
      where: { singletonKey: "default" },
      create: { singletonKey: "default", ...data },
      update: data,
    });
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
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.category) where.category = String(req.query.category).toLowerCase();
    if (req.query.language) where.language = String(req.query.language);
    if (req.query.topic) where.topic = { contains: String(req.query.topic).slice(0, 80) };
    const items = await prisma.aIGeneratedPost.findMany({ where, orderBy: { generatedAt: "desc" }, take: 100 });
    return res.json(items.map(withHashtags));
  } catch (error) { return next(error); }
};

exports.publish = async (req, res) => {
  try {
    const item = await findGenerated(req.params.id);
    if (!item || item.status === "deleted") return res.status(404).json({ message: "Generated post not found" });
    if (item.status === "published") return res.json(item);
    const post = await prisma.post.create({
      data: buildAiPostData({
        caption: item.caption,
        hashtags: item.hashtags,
        imageUrl: item.imageUrl,
        author: item.author,
        category: item.category,
        provider: item.provider,
      }),
    });
    const updated = await prisma.aIGeneratedPost.update({
      where: { id: item.id },
      data: { post: post.id, status: "published", publishedAt: new Date() },
    });
    return res.json(withHashtags(updated));
  } catch (error) { return res.status(502).json({ message: publicError(error) }); }
};

exports.updateGenerated = async (req, res) => {
  if (!(await findGenerated(req.params.id))) return res.status(404).json({ message: "Generated post not found" });
  const data = { caption: String(req.body?.caption || "").trim().slice(0, 500) };
  if (Array.isArray(req.body?.hashtags)) data.hashtags = req.body.hashtags.slice(0, 8);
  const item = withHashtags(await prisma.aIGeneratedPost.update({ where: { id: req.params.id }, data }));
  if (item.post) {
    await prisma.post.updateMany({ where: { id: item.post }, data: { caption: captionWithTags(item) } });
  }
  return res.json(item);
};

exports.deleteGenerated = async (req, res) => {
  if (!(await findGenerated(req.params.id))) return res.status(404).json({ message: "Generated post not found" });
  const item = await prisma.aIGeneratedPost.update({ where: { id: req.params.id }, data: { status: "deleted" } });
  if (item.post) await prisma.post.deleteMany({ where: { id: item.post } });
  return res.json({ ok: true });
};

exports.regenerate = async (req, res) => {
  try { return res.status(201).json(await generateAutoPost({ config: await getConfig(), publish: false })); } catch (error) { return res.status(502).json({ message: publicError(error) }); }
};

exports.setPaused = async (req, res, next) => {
  try {
    const paused = Boolean(req.body?.paused);
    await prisma.aIAutoPostConfig.upsert({
      where: { singletonKey: "default" },
      create: { singletonKey: "default", paused },
      update: { paused },
    });
    return res.json({ paused });
  } catch (error) { return next(error); }
};
