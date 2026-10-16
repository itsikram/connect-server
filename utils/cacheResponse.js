// Express middleware that caches successful JSON GET responses in memory
// (utils/cache.js). Entries are tagged with the Prisma models the response is
// built from, so any write to those tables drops them right away; the TTL only
// bounds how long an unchanged response is reused.
//
//   Router.get('/newsFeed', isAuth, cacheResponse({ ttl: 30, tags: CONTENT_TAGS }), getNewsFeed)
//
// Responses are cached per signed-in profile (anonymous requests share one
// entry per URL). Clients see the exact same body, plus `X-Cache: HIT|MISS`.
const cache = require("./cache");

// Tag groups (Prisma model names).
const GRAPH_TAGS = ["Profile", "User", "ProfileConnect", "ConnectRequest", "Follow", "Block", "Relationship", "Setting"];
// PostViewer / StorySeen are left out on purpose: they are written on every
// view and would flush feeds constantly; a few seconds' stale view list is fine.
const CONTENT_TAGS = [
  ...GRAPH_TAGS,
  "Post",
  "PostReact",
  "PostShare",
  "PostMention",
  "Watch",
  "WatchReact",
  "WatchShare",
  "Story",
  "StoryReact",
  "Comment",
  "CmntReply",
];
const MESSAGE_TAGS = [...GRAPH_TAGS, "Message"];
const NOTIFICATION_TAGS = ["Notification"];

function cacheResponse({ ttl = 30, tags = CONTENT_TAGS } = {}) {
  const ttlMs = ttl * 1000;
  return (req, res, next) => {
    if (req.method !== "GET" || cache.disabled()) return next();
    const viewer = req.profile?._id ? String(req.profile._id) : "anon";
    const key = `res:${viewer}:${req.originalUrl}`;

    const hit = cache.get(key);
    if (hit !== undefined) {
      res.set("X-Cache", "HIT");
      res.type("application/json");
      return res.status(200).send(hit);
    }

    const startedAt = cache.snapshot(tags);
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200 && body !== undefined) {
        const text = JSON.stringify(body);
        cache.setIfUnchanged(startedAt, key, text, ttlMs, tags);
        res.set("X-Cache", "MISS");
        res.type("application/json");
        return res.send(text);
      }
      return json(body);
    };
    return next();
  };
}

module.exports = { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS };
