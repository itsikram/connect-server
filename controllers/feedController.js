const Profile = require('../models/Profile');
const { getRecommendations } = require('../services/recommendationService');

const audienceFilter = (profile) => ({
    $and: [
        { $or: [{ audience: 1 }, { audience: 2, author: { $in: profile.friends || [] } }, { audience: 3, author: profile._id }] },
        { author: { $nin: profile.blockedUsers || [] } },
    ],
});

exports.getRankedPosts = async (req, res, next) => {
    try {
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 40);
        const result = await getRecommendations({ profileId: req.profile._id, kind: 'post', page, limit, filter: audienceFilter(req.profile) });
        return res.json({ posts: result.items, hasMore: result.hasMore, coldStart: result.coldStart });
    } catch (error) { return next(error); }
};

exports.getRankedWatches = async (req, res, next) => {
    try {
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 40);
        const profile = await Profile.findById(req.profile._id).select('friends blockedUsers').lean();
        const result = await getRecommendations({ profileId: req.profile._id, kind: 'watch', page, limit, filter: audienceFilter({ ...profile, _id: req.profile._id }) });
        return res.json({ watches: result.items, hasMore: result.hasMore, coldStart: result.coldStart });
    } catch (error) { return next(error); }
};
