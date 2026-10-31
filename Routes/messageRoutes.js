const Router = require('express').Router()
const isAuth = require('../middlewares/isAuth')
const {addMessageReact,removeMessageReact,getMedia,getChatList,getChatHistory,getOldMessages,sendMessage,getNewMessages,getNewMessagesCount,getMessageReactions,markMessageAsSeen,deleteMessage,editMessage,deleteConversation,sendBump,openSecureMessage} = require('../controllers/messageController')
const uploadAttachment = require('../middlewares/photosUpload')
const { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS } = require('../utils/cacheResponse')


Router.post('/addReact',isAuth,addMessageReact);
Router.get('/media',isAuth,getMedia);
Router.post('/removeReact',isAuth,removeMessageReact);
Router.get('/chatList',isAuth,cacheResponse({ ttl: 15, tags: MESSAGE_TAGS }),getChatList);
Router.get('/getChatHistory',isAuth,getChatHistory);
Router.get('/getOldMessages',isAuth,getOldMessages);
Router.post('/send',isAuth,sendMessage);
Router.get('/new-messages',isAuth,getNewMessages);
Router.get('/new-messages-count',isAuth,getNewMessagesCount);
Router.get('/reactions',isAuth,getMessageReactions);
Router.post('/seen',isAuth,markMessageAsSeen);
Router.post('/delete',isAuth,deleteMessage);
Router.post('/edit',isAuth,editMessage);
Router.post('/deleteConversation',isAuth,deleteConversation);
Router.post('/bump',isAuth,sendBump);
Router.post('/secure/open',isAuth,openSecureMessage);


module.exports = Router;