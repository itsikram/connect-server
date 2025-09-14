const Router = require("express").Router();
const {signUp,login,deleteAccount,getProfiles,getProfile,updateProfile,deleteProfile,getPosts,getPost,updatePost,deletePost,getWatches,getWatch,updateWatch,deleteWatch} = require('../controllers/adminController')
const {uploadImage} = require('../controllers/uploadControllers')
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

Router.post('/signup',signUp)
Router.post('/login',login)
Router.post('/delete',deleteAccount)
Router.get('/profiles',getProfiles)
Router.get('/profile/:id',getProfile)
Router.put('/profile/:id',updateProfile)
Router.delete('/profile/:id',deleteProfile)
Router.get('/posts',getPosts)
Router.get('/posts/:id',getPost)
Router.put('/posts/:id',updatePost)
Router.delete('/posts/:id',deletePost)
Router.get('/watches',getWatches)
Router.get('/watches/:id',getWatch)
Router.put('/watches/:id',updateWatch)
Router.delete('/watches/:id',deleteWatch)
Router.post('/upload',upload.single('image'),uploadImage)

module.exports = Router;