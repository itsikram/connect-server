const Router = require('express').Router()
const isAuth = require('../middlewares/isAuth')
const {postConnectReq,postBlockConnect,postUnblockConnect,postDisconnect,postRemoveConnectReq,getConnectReq,getSentConnectReq,getProfileSuggetions,getProfileConnect,postConnectAccept,postConnectDelete,getBlockStatus,getRelationships,updateRelationships,getRequestStatus} = require('../controllers/relationshipController')
const { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS } = require('../utils/cacheResponse')


Router.get('/getRequest',isAuth,cacheResponse({ ttl: 30, tags: GRAPH_TAGS }),getConnectReq)
Router.get('/getSentRequest',isAuth,cacheResponse({ ttl: 30, tags: GRAPH_TAGS }),getSentConnectReq)
Router.get('/getSuggetions',isAuth,cacheResponse({ ttl: 60, tags: GRAPH_TAGS }),getProfileSuggetions)
Router.get('/getConnects',isAuth,cacheResponse({ ttl: 30, tags: GRAPH_TAGS }),getProfileConnect)
Router.get('/block-status',isAuth,getBlockStatus)
Router.get('/relationships',isAuth,getRelationships)
Router.put('/relationships',isAuth,updateRelationships)
Router.get('/request-status',isAuth,getRequestStatus)
Router.post('/sendRequest',isAuth,postConnectReq)
Router.post('/block',isAuth,postBlockConnect)
Router.post('/unblock',isAuth,postUnblockConnect)
Router.post('/removeRequest',isAuth,postRemoveConnectReq)
Router.post('/reqAccept',isAuth,postConnectAccept)
Router.post('/reqDelete',isAuth,postConnectDelete)
Router.post('/disconnect',isAuth,postDisconnect)

module.exports = Router;
