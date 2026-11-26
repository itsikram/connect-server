const Router = require('express').Router()
const {uploadImage,uploadVideo,uploadFile} = require('../controllers/uploadControllers')
const isAuth = require('../middlewares/isAuth')
const isAdminAuth = require('../middlewares/isAdminAuth')
const personalDrive = require('../controllers/personalDriveController');
const { CHAT_LIMIT } = require('../services/personalDrive');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() }); // Create an endpoint for image upload 

Router.post('/', isAuth,upload.single('image'), uploadImage);
Router.post('/admin', isAdminAuth, upload.single('image'), uploadImage);
Router.post('/video', isAuth,upload.single('attachment'), uploadVideo);
Router.post('/file', isAuth,upload.single('file'), uploadFile);

const chatUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CHAT_LIMIT, files: 1, fields: 1, fieldSize: 100 },
}).single('file');
const prepareChatUpload = (req, res, next) => personalDrive.prepareUpload(req, res, next).catch(next);
const cloudinaryChatUpload = upload.single('file');
Router.post('/chat/:kind', isAuth, prepareChatUpload, (req, res, next) => {
    const parse = req.personalDriveUpload ? chatUpload : cloudinaryChatUpload;
    parse(req, res, (error) => {
        if (error?.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'Chat files must be 25 MB or smaller.' });
        }
        if (error) return res.status(400).json({ error: 'Invalid chat upload.' });
        Promise.resolve(personalDrive.upload(req, res, next)).catch(next);
    });
});

module.exports = Router;
