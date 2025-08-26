const Router = require('express').Router()
const isAuth = require('../middlewares/isAuth')
const {postAddComment,updateComment,storyAddComment, postDeleteComment,addCommentReact,removeCommentReact,postCommentReply,removeCommentReply,addReplyReact,removeReplyReact} = require('../controllers/commentController')

Router.post('/addComment',isAuth,postAddComment)
Router.post('/updateComment',isAuth,updateComment)
Router.post('/deleteComment',isAuth,postDeleteComment);
Router.post('/addReact',isAuth,addCommentReact);
Router.post('/addReply',isAuth,postCommentReply);
Router.post('/deleteReply',isAuth,removeCommentReply);
Router.post('/removeReact',isAuth,removeCommentReact);
Router.post('/reply/addReact',isAuth,addReplyReact);
Router.post('/reply/removeReact',isAuth,removeReplyReact);
Router.post('/story/addComment',isAuth,storyAddComment)


module.exports = Router;