const Post = require('../models/Post');
const Watch = require('../models/Watch');
const Comment = require('../models/Comment');
const CmntReply = require('../models/CmntReply');
const Profile = require('../models/Profile');
const UserInterestProfile = require('../models/UserInterestProfile');

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

const getRecommendations = async ({
    profileId,
    kind,
    page = 1,
    limit = 10,
    filter = {},
    fallbackFilter = {},
    context = {},
}) => {
    const Model = kind === 'watch' ? Watch : Post;
    const profile = await rebuildInterestProfile(profileId);
    const buildQuery = (queryFilter) => {
        const query = Model.find(queryFilter).sort({ createdAt: -1 }).limit(Math.max(limit * 50, 500));
        query.populate({ path: 'author', select: 'fullName displayName username nickname profilePic isOfficial isVerified isActive user', populate: { path: 'user', select: 'firstName surname' } });
        query.populate({
            path: 'comments',
            model: Comment,
            options: { sort: { createdAt: -1 }, limit: 50 },
            populate: [{
                path: 'author',
                model: Profile,
                select: 'profilePic user fullName displayName username nickname',
                populate: {
                    path: 'user',
                    select: 'firstName surname displayName fullName',
                },
            }, {
                path: 'replies',
                model: CmntReply,
                populate: {
                    path: 'author',
                    model: Profile,
                    select: 'profilePic user fullName displayName username nickname',
                    populate: {
                        path: 'user',
                        select: 'firstName surname displayName fullName',
                    },
                },
            }],
        });
        if (kind === 'post') query.populate({ path: 'parentPost', select: 'author caption photos type createdAt' });
        return query;
    };

    let candidates = await buildQuery(filter).lean();
    let fallbackUsed = false;
    // If the personalized/connection-aware feed is empty, use only public content.
    if (candidates.length === 0 && Object.keys(fallbackFilter).length > 0) {
        candidates = await buildQuery(fallbackFilter).lean();
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

const updateInterestProfile = async ({ profileId, item }) => {
    const categories = [...new Set((item?.aiMetadata?.categories || [])
        .map((category) => String(category || '').trim().toLowerCase())
        .filter(Boolean))];
    if (!categories.length) return;
    const increments = {};
    categories.forEach((category) => { increments[`categories.${category}`] = 1; });
    await UserInterestProfile.findOneAndUpdate({ profile: profileId }, { $inc: { ...increments, interactionCount: 1 }, $set: { updatedAt: new Date() } }, { upsert: true });
};

const rebuildInterestProfile = async (profileId) => {
    const profiles = await rebuildInterestProfiles([profileId]);
    return profiles.get(String(profileId)) || null;
};

const rebuildInterestProfiles = async (profileIds) => {
    const ids = profileIds.filter(Boolean);
    const scoresByProfile = new Map(ids.map((id) => [String(id), { categories: {}, interactionCount: 0 }]));
    const [posts, watches] = await Promise.all([
        Post.find({ 'reacts.profile': { $in: ids } }).select('reacts.profile aiMetadata.categories').lean(),
        Watch.find({ 'reacts.profile': { $in: ids } }).select('reacts.profile aiMetadata.categories').lean(),
    ]);
    for (const item of [...posts, ...watches]) {
        const categories = [...new Set((item.aiMetadata?.categories || [])
            .map((category) => String(category || '').trim().toLowerCase())
            .filter(Boolean))];
        if (!categories.length) continue;
        const reactors = [...new Set((item.reacts || []).map((react) => String(react.profile)).filter(Boolean))];
        reactors.forEach((profileId) => {
            const scores = scoresByProfile.get(profileId);
            if (!scores) return;
            scores.interactionCount += 1;
            categories.forEach((category) => { scores.categories[category] = (scores.categories[category] || 0) + 1; });
        });
    }
    const updatedAt = new Date();
    await UserInterestProfile.bulkWrite([...scoresByProfile.entries()].map(([profile, scores]) => ({
        updateOne: {
            filter: { profile },
            update: { $set: { categories: scores.categories, interactionCount: scores.interactionCount, updatedAt } },
            upsert: true,
        },
    })));
    return new Map([...scoresByProfile.keys()].map((profile) => [profile, { profile, ...scoresByProfile.get(profile), updatedAt }]));
};

module.exports = { cosineSimilarity, rankItems, getRecommendations, updateInterestProfile, rebuildInterestProfile, rebuildInterestProfiles };
