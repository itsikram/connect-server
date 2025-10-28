const Router = require('express').Router()
const isAuth = require('../middlewares/isAuth')
const {addMessageReact,removeMessageReact,getMedia,getChatList,getChatHistory,getOldMessages} = require('../controllers/messageController')
const uploadAttachment = require('../middlewares/photosUpload')


Router.post('/addReact',isAuth,addMessageReact);
Router.get('/media',isAuth,getMedia);
Router.post('/removeReact',isAuth,removeMessageReact);
Router.get('/chatList',isAuth,getChatList);
Router.get('/getChatHistory',isAuth,getChatHistory);
Router.get('/getOldMessages',isAuth,getOldMessages);


module.exports = Router;