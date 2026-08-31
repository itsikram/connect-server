const Router = require('express').Router();
const optionalAuth = require('../middlewares/optionalAuth');
const {
  startDownload,
  getProgress,
  searchVideos,
} = require('../controllers/ytDownloadController');

Router.get('/download', optionalAuth, startDownload);
Router.get('/progress/:progressId', getProgress);
Router.get('/youtube/search', optionalAuth, searchVideos);

// Videos are uploaded to Cloudinary — no public /files static serving

module.exports = Router;
