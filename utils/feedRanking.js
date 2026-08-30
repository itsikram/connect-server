const scorePost = (post, { friendIds = new Set(), currentUserId } = {}) => {
  const created = post?.createdAt ? new Date(post.createdAt).getTime() : Date.now();
  const hoursAgo = Math.max(0, (Date.now() - created) / 3600000);
  const recency = (48 / (48 + hoursAgo)) * 40;
  const reacts = Math.min(Array.isArray(post?.reacts) ? post.reacts.length : 0, 50) * 1.2;
  const comments = Math.min(Array.isArray(post?.comments) ? post.comments.length : 0, 40) * 2;
  const authorId = String(post?.author?._id || post?.author || "");
  const friendBoost = friendIds.has(authorId) ? 12 : 0;
  const selfBoost = String(currentUserId) === authorId ? 4 : 0;
  const officialBoost = post?.author?.isOfficial ? 6 : 0;
  return recency + reacts + comments + friendBoost + selfBoost + officialBoost;
};

const rankPosts = (posts, context) => {
  if (!Array.isArray(posts) || posts.length === 0) return [];
  return [...posts].sort((a, b) => {
    const scoreDelta = scorePost(b, context) - scorePost(a, context);
    if (scoreDelta !== 0) return scoreDelta;
    const aTime = new Date(a?.createdAt || 0).getTime();
    const bTime = new Date(b?.createdAt || 0).getTime();
    return bTime - aTime;
  });
};

module.exports = {
  scorePost,
  rankPosts,
};
