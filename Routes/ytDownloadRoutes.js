const Router = require('express').Router();
const optionalAuth = require('../middlewares/optionalAuth');
const { startDownload, getProgress } = require('../controllers/ytDownloadController');

Router.get('/download', optionalAuth, startDownload);
Router.get('/progress/:progressId', getProgress);

// Videos are uploaded to Cloudinary — no public /files static serving

module.exports = Router;
