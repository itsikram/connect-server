const Router = require('express').Router()
const {prefileHasStory,getProfileImages,profileGet,profilePost,updateBioPost,updateCoverPost,updateProfilePic,updateProfile} = require('../controllers/profileController')
const coverPicUpload = require('../middlewares/UploadCover')
const photosUpload = require('../middlewares/photosUpload')
const isAuth = require('../middlewares/isAuth')
const Profile = require('../models/Profile')
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() }); // Create an endpoint for image upload 

Router.get('/', profileGet)
Router.get('/hasStory', prefileHasStory)
Router.get('/getImages', getProfileImages)
Router.post('/',profilePost)
Router.post('/update/coverPic',upload.single('image'),isAuth,updateCoverPost)
Router.post('/update/profilePic',upload.single('image'),isAuth,updateProfilePic)
Router.post('/update/bio',isAuth,updateBioPost)
Router.post('/update',isAuth,updateProfile)

module.exports = Router;