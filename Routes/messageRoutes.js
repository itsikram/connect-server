const Router = require('express').Router()
const isAuth = require('../middlewares/isAuth')
const {addMessageReact,removeMessageReact,getMedia,getChatList,getChatHistory,getOldMessages,sendMessage,getNewMessages,getNewMessagesCount,getMessageReactions,markMessageAsSeen,deleteMessage,sendBump} = require('../controllers/messageController')
const uploadAttachment = require('../middlewares/photosUpload')


Router.post('/addReact',isAuth,addMessageReact);
Router.get('/media',isAuth,getMedia);
Router.post('/removeReact',isAuth,removeMessageReact);
Router.get('/chatList',isAuth,getChatList);
Router.get('/getChatHistory',isAuth,getChatHistory);
Router.get('/getOldMessages',isAuth,getOldMessages);
Router.post('/send',isAuth,sendMessage);
Router.get('/new-messages',isAuth,getNewMessages);
Router.get('/new-messages-count',isAuth,getNewMessagesCount);
Router.get('/reactions',isAuth,getMessageReactions);
Router.post('/seen',isAuth,markMessageAsSeen);
Router.post('/delete',isAuth,deleteMessage);
Router.post('/bump',isAuth,sendBump);


module.exports = Router;