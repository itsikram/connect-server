const Router = require('express').Router()
const {uploadImage,uploadVideo,uploadFile} = require('../controllers/uploadControllers')
const isAuth = require('../middlewares/isAuth')
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() }); // Create an endpoint for image upload 

Router.post('/', isAuth,upload.single('image'), uploadImage);
Router.post('/video', isAuth,upload.single('attachment'), uploadVideo);
Router.post('/file', isAuth,upload.single('file'), uploadFile);

module.exports = Router;