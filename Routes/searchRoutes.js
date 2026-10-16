const Router = require('express').Router()
const {getSearchResult} = require('../controllers/searchControllers')
const { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS } = require('../utils/cacheResponse')

Router.get('/',cacheResponse({ ttl: 30, tags: CONTENT_TAGS }),getSearchResult)
// Router.post('/removeReact',isAuth,postRemoveReact)


module.exports = Router