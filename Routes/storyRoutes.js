const Router = require('express').Router()
const {postStory,getSingleStory,deleteStory,getAllStories} = require('../controllers/storyController')
const {addStoryReact,deleteStoryReact} = require('../controllers/reactControllers')
const {storyAddComment} = require('../controllers/commentController')
const isAuth = require('../middlewares/isAuth')

Router.get('/',getAllStories)
Router.get('/single',getSingleStory)
Router.post('/create',isAuth,postStory)
Router.post('/delete',isAuth,deleteStory)
Router.post('/addReact',isAuth,addStoryReact)
Router.post('/postComment',isAuth,storyAddComment)


module.exports = Router