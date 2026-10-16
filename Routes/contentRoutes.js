const Router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const { getDigest } = require("../controllers/contentController");
const { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS } = require('../utils/cacheResponse')

Router.get("/digest", isAuth, cacheResponse({ ttl: 60, tags: [...CONTENT_TAGS, "Note", "CalendarEvent"] }), getDigest);

module.exports = Router;
