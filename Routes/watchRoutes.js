const Router = require('express').Router()
const {createWatch,deleteWatch,getMyWatchs,getRelatedWatchs,getProfileWatch, getSingleWatch,updateWatch} = require('../controllers/watchController')
const photosUpload = require('../middlewares/photosUpload')
const isAuth = require('../middlewares/isAuth')

Router.post('/create',isAuth,photosUpload.single('attachment'),createWatch)
Router.post('/delete', isAuth, deleteWatch)
Router.post('/update',isAuth, updateWatch)
Router.post('')
Router.get('/myWatchs',isAuth,getMyWatchs)
Router.get('/related',isAuth,getRelatedWatchs)
Router.get('/profileWatch',getProfileWatch)
Router.get('/single',getSingleWatch)

module.exports = Router;

