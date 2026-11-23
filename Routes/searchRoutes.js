const Router = require('express').Router()
const {getSearchResult} = require('../controllers/searchControllers')
const optionalAuth = require('../middlewares/optionalAuth')
const { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS } = require('../utils/cacheResponse')

// optionalAuth before the cache (its key is per viewer): post / video results follow their audience
Router.get('/',optionalAuth,cacheResponse({ ttl: 30, tags: CONTENT_TAGS }),getSearchResult)
// Router.post('/removeReact',isAuth,postRemoveReact)


module.exports = Router