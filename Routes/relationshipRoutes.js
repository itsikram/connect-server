const Router = require('express').Router()
const isAuth = require('../middlewares/isAuth')
const {postConnectReq,postBlockConnect,postUnblockConnect,postDisconnect,postRemoveConnectReq,getConnectReq,getProfileSuggetions,getProfileConnect,postConnectAccept,postConnectDelete,getBlockStatus} = require('../controllers/relationshipController')


Router.get('/getRequest',isAuth,getConnectReq)
Router.get('/getSuggetions',isAuth,getProfileSuggetions)
Router.get('/getConnects',isAuth,getProfileConnect)
Router.get('/block-status',isAuth,getBlockStatus)
Router.post('/sendRequest',isAuth,postConnectReq)
Router.post('/block',isAuth,postBlockConnect)
Router.post('/unblock',isAuth,postUnblockConnect)
Router.post('/removeRequest',isAuth,postRemoveConnectReq)
Router.post('/reqAccept',isAuth,postConnectAccept)
Router.post('/reqDelete',isAuth,postConnectDelete)
Router.post('/disconnect',isAuth,postDisconnect)

module.exports = Router;



