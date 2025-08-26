const Router = require('express').Router()
const {createPost,deletePost,sharePost,getMyPosts,getNewsFeed, getSinglePost,updatePost} = require('../controllers/postController')
const photosUpload = require('../middlewares/photosUpload')
const isAuth = require('../middlewares/isAuth')


Router.post('/create',isAuth,photosUpload.single('photos'),createPost)
Router.post('/share', isAuth, sharePost)
Router.post('/delete', isAuth, deletePost)
Router.post('/update', isAuth, updatePost)
Router.get('/myPosts',isAuth,getMyPosts)
Router.get('/newsFeed',getNewsFeed)
Router.get('/single',getSinglePost)

module.exports = Router;