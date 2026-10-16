const Router = require('express').Router()
const {createPost,deletePost,sharePost,getMyPosts,getNewsFeed, getSinglePost,updatePost} = require('../controllers/postController')
const photosUpload = require('../middlewares/photosUpload')
const isAuth = require('../middlewares/isAuth')
const { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS } = require('../utils/cacheResponse')


Router.post('/create',isAuth,photosUpload.single('photos'),createPost)
Router.post('/share', isAuth, sharePost)
Router.post('/delete', isAuth, deletePost)
Router.post('/update', isAuth, updatePost)
Router.get('/myPosts',isAuth,cacheResponse({ ttl: 30, tags: CONTENT_TAGS }),getMyPosts)
Router.get('/newsFeed',isAuth,cacheResponse({ ttl: 30, tags: CONTENT_TAGS }),getNewsFeed)
Router.get('/single',getSinglePost)

module.exports = Router;