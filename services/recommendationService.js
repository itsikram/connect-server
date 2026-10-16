const { prisma, jsonObject } = require('../utils/db');
const { profileArgs, commentInclude, postInclude, watchInclude, shapePost, shapeWatch } = require('./contentShape');

const cosineSimilarity = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0; let aNorm = 0; let bNorm = 0;
    for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aNorm += a[i] ** 2; bNorm += b[i] ** 2; }
    return aNorm && bNorm ? dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm)) : 0;
};

const categoryScore = (categories, profileCategories) => (categories || []).reduce((sum, category) => sum + (Number(profileCategories?.get?.(category) || profileCategories?.[category]) || 0), 0);
const engagementScore = (item) => Math.min((item?.reacts?.length || 0) * 0.8 + (item?.comments?.length || 0) * 1.2 + (item?.shares?.length || 0) * 1.5, 25);
const recencyScore = (item) => 20 * (48 / (48 + Math.max(0, (Date.now() - new Date(item.createdAt || Date.now()).getTime()) / 3600000)));

const rankItems = (items, profile, context = {}) => {
    const profileCategories = profile?.categories || {};
    const connectIds = new Set((context.connects || []).map((id) => String(id)));
    const currentUserId = String(context.profileId || '');
    const ranked = items.map((item) => ({
        item,
        score: (() => {
            const authorId = String(item.author?._id || item.author || '');
            const hoursAgo = Math.max(0, (Date.now() - new Date(item.createdAt || Date.now()).getTime()) / 3600000);
            const relevance = categoryScore(item.aiMetadata?.categories, profileCategories) * 12
                + cosineSimilarity(item.aiMetadata?.embedding, profile?.embedding) * 40;
            const relationship = authorId === currentUserId
                ? (hoursAgo <= 24 ? 4 : -28)
                : (connectIds.has(authorId) ? 24 : 8);
            return relevance + relationship + engagementScore(item) + recencyScore(item);
        })(),
    })).sort((a, b) => b.score - a.score);
    return ranked.map((entry) => entry.item);
};

const FEED_AUTHOR = profileArgs(
    ['fullName', 'displayName', 'username', 'nickname', 'profilePic', 'isOfficial', 'isVerified', 'isActive'],
    ['firstName', 'surname']
);
const FEED_COMMENT_AUTHOR = profileArgs(
    ['profilePic', 'fullName', 'displayName', 'username', 'nickname'],
    ['firstName', 'surname']
);

/**
 * `filter` / `fallbackFilter` are Prisma `where` objects for the Post / Watch
 * model (see contentShape audienceWhere / publicWhere).
 */
const getRecommendations = async ({
    profileId,
    kind,
    page = 1,
    limit = 10,
    filter = {},
    fallbackFilter = {},
    context = {},
}) => {
    const profile = await rebuildInterestProfile(profileId);
    const fetchCandidates = async (where) => {
        const commentOptions = {
            comments: commentInclude(FEED_COMMENT_AUTHOR),
            commentsExtra: { orderBy: { createdAt: 'desc' }, take: 50 },
        };
        const take = Math.max(limit * 50, 500);
        if (kind === 'watch') {
            const rows = await prisma.watch.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take,
                include: watchInclude({ author: FEED_AUTHOR, ...commentOptions }),
            });
            return rows.map(shapeWatch);
        }
        const rows = await prisma.post.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take,
            include: {
                ...postInclude({ author: FEED_AUTHOR, ...commentOptions }),
                parentPostDoc: { select: { id: true, author: true, caption: true, photos: true, type: true, createdAt: true } },
            },
        });
        return rows.map(shapePost);
    };

    let candidates = await fetchCandidates(filter);
    let fallbackUsed = false;
    // If the personalized/connection-aware feed is empty, use only public content.
    if (candidates.length === 0 && Object.keys(fallbackFilter).length > 0) {
        candidates = await fetchCandidates(fallbackFilter);
        fallbackUsed = candidates.length > 0;
    }

    const ranked = rankItems(candidates, profile, { profileId, connects: context?.connects });
    const start = (page - 1) * limit;
    return {
        items: ranked.slice(start, start + limit),
        hasMore: start + limit < ranked.length,
        coldStart: !profile || !profile.interactionCount,
        fallbackUsed,
    };
};

const normalizeCategories = (categories) => [...new Set((Array.isArray(categories) ? categories : [])
    .map((category) => String(category || '').trim().toLowerCase())
    .filter(Boolean))];

const updateInterestProfile = async ({ profileId, item }) => {
    const categories = normalizeCategories(item?.aiMetadata?.categories);
    if (!categories.length || !profileId) return;
    const profile = String(profileId);
    await prisma.$transaction(async (tx) => {
        const existing = await tx.userInterestProfile.findUnique({ where: { profile } });
        const next = { ...jsonObject(existing?.categories) };
        categories.forEach((category) => { next[category] = (Number(next[category]) || 0) + 1; });
        await tx.userInterestProfile.upsert({
            where: { profile },
            update: { categories: next, interactionCount: { increment: 1 } },
            create: { profile, categories: next, interactionCount: 1 },
        });
    });
};

const rebuildInterestProfile = async (profileId) => {
    const profiles = await rebuildInterestProfiles([profileId]);
    return profiles.get(String(profileId)) || null;
};

const rebuildInterestProfiles = async (profileIds) => {
    const ids = profileIds.filter(Boolean).map(String);
    const scoresByProfile = new Map(ids.map((id) => [id, { categories: {}, interactionCount: 0 }]));
    if (!ids.length) return new Map();
    const [postReacts, watchReacts] = await Promise.all([
        prisma.postReact.findMany({ where: { profile: { in: ids } }, select: { post: true, profile: true } }),
        prisma.watchReact.findMany({ where: { profile: { in: ids } }, select: { watch: true, profile: true } }),
    ]);
    const postIds = [...new Set(postReacts.map((row) => row.post))];
    const watchIds = [...new Set(watchReacts.map((row) => row.watch))];
    const [posts, watches] = await Promise.all([
        postIds.length ? prisma.post.findMany({ where: { id: { in: postIds } }, select: { id: true, aiCategories: true } }) : [],
        watchIds.length ? prisma.watch.findMany({ where: { id: { in: watchIds } }, select: { id: true, aiCategories: true } }) : [],
    ]);
    const postCategories = new Map(posts.map((row) => [row.id, normalizeCategories(row.aiCategories)]));
    const watchCategories = new Map(watches.map((row) => [row.id, normalizeCategories(row.aiCategories)]));
    // One interaction per (item, reactor), as the old per-item reactor de-dup did.
    const credit = (profileId, categories) => {
        if (!categories?.length) return;
        const scores = scoresByProfile.get(profileId);
        if (!scores) return;
        scores.interactionCount += 1;
        categories.forEach((category) => { scores.categories[category] = (scores.categories[category] || 0) + 1; });
    };
    postReacts.forEach((row) => credit(row.profile, postCategories.get(row.post)));
    watchReacts.forEach((row) => credit(row.profile, watchCategories.get(row.watch)));

    const updatedAt = new Date();
    await prisma.$transaction([...scoresByProfile.entries()].map(([profile, scores]) => prisma.userInterestProfile.upsert({
        where: { profile },
        update: { categories: scores.categories, interactionCount: scores.interactionCount },
        create: { profile, categories: scores.categories, interactionCount: scores.interactionCount },
    })));
    return new Map([...scoresByProfile.keys()].map((profile) => [profile, { profile, ...scoresByProfile.get(profile), updatedAt }]));
};

module.exports = { cosineSimilarity, rankItems, getRecommendations, updateInterestProfile, rebuildInterestProfile, rebuildInterestProfiles };
