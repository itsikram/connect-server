const Router = require('express').Router()
const {createWatch,deleteWatch,getMyWatchs,getRelatedWatchs,searchWatches,getProfileWatch, getSingleWatch,updateWatch,shareWatch} = require('../controllers/watchController')
const isAuth = require('../middlewares/isAuth')
const { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS } = require('../utils/cacheResponse')

// Video is uploaded separately via /upload/video; create only receives JSON metadata.
Router.post('/create', isAuth, createWatch)
Router.post('/delete', isAuth, deleteWatch)
Router.post('/update',isAuth, updateWatch)
Router.get('/myWatchs',isAuth,cacheResponse({ ttl: 30, tags: CONTENT_TAGS }),getMyWatchs)
Router.get('/related',isAuth,cacheResponse({ ttl: 60, tags: CONTENT_TAGS }),getRelatedWatchs)
Router.get('/search',isAuth,searchWatches)
Router.get('/profileWatch',cacheResponse({ ttl: 30, tags: CONTENT_TAGS }),getProfileWatch)
Router.get('/single',getSingleWatch)
Router.post('/share', isAuth, shareWatch)

module.exports = Router;

