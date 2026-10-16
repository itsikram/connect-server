const { getRecommendations } = require('../services/recommendationService');
const { audienceLists, audienceWhere, publicWhere } = require('../services/contentShape');

exports.getRankedPosts = async (req, res, next) => {
    try {
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 40);
        const lists = await audienceLists(req.profile);
        const result = await getRecommendations({
            profileId: req.profile._id,
            kind: 'post',
            page,
            limit,
            filter: audienceWhere(req.profile._id, lists),
            fallbackFilter: publicWhere(lists),
            context: { profileId: req.profile._id, connects: lists.connects },
        });
        return res.json({
            posts: result.items,
            hasMore: result.hasMore,
            coldStart: result.coldStart,
            fallback: result.fallbackUsed,
        });
    } catch (error) { return next(error); }
};

exports.getRankedWatches = async (req, res, next) => {
    try {
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 40);
        // Fresh lists from the database, as the old Profile.findById re-read did.
        const lists = await audienceLists({ _id: req.profile._id });
        const result = await getRecommendations({
            profileId: req.profile._id,
            kind: 'watch',
            page,
            limit,
            filter: audienceWhere(req.profile._id, lists),
            fallbackFilter: publicWhere(lists),
            context: { profileId: req.profile._id, connects: lists.connects },
        });
        return res.json({
            watches: result.items,
            hasMore: result.hasMore,
            coldStart: result.coldStart,
            fallback: result.fallbackUsed,
        });
    } catch (error) { return next(error); }
};
