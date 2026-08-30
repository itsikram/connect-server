const Router = require('express').Router()
const {createWatch,deleteWatch,getMyWatchs,getRelatedWatchs,getProfileWatch, getSingleWatch,updateWatch,shareWatch} = require('../controllers/watchController')
const isAuth = require('../middlewares/isAuth')

// Video is uploaded separately via /upload/video; create only receives JSON metadata.
Router.post('/create', isAuth, createWatch)
Router.post('/delete', isAuth, deleteWatch)
Router.post('/update',isAuth, updateWatch)
Router.get('/myWatchs',isAuth,getMyWatchs)
Router.get('/related',isAuth,getRelatedWatchs)
Router.get('/profileWatch',getProfileWatch)
Router.get('/single',getSingleWatch)
Router.post('/share', isAuth, shareWatch)

module.exports = Router;

