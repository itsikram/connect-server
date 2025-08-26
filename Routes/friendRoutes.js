const Router = require('express').Router()
const isAuth = require('../middlewares/isAuth')
const {postFrndReq,postBlockFrnd,postUnblockFrnd,postRemoveFrnd,postRemoveFrndReq,getFrndReq,getProfileSuggetions,getProfileFrnd,postFrndAccept,postFrndDelete} = require('../controllers/friendController')


Router.get('/getRequest',isAuth,getFrndReq)
Router.get('/getSuggetions',isAuth,getProfileSuggetions)
Router.get('/getFriends',isAuth,getProfileFrnd)
Router.post('/sendRequest',isAuth,postFrndReq)
Router.post('/block',isAuth,postBlockFrnd)
Router.post('/unblock',isAuth,postUnblockFrnd)
Router.post('/removeRequest',isAuth,postRemoveFrndReq)
Router.post('/reqAccept',isAuth,postFrndAccept)
Router.post('/reqDelete',isAuth,postFrndDelete)
Router.post('/removeFriend',isAuth,postRemoveFrnd)

module.exports = Router;




