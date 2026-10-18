const Router = require('express').Router();
const optionalAuth = require('../middlewares/optionalAuth');
const requireFeatureFlag = require('../middlewares/requireFeatureFlag');
const {
  startDownload,
  getProgress,
  searchVideos,
} = require('../controllers/ytDownloadController');

const requireYtDownloads = requireFeatureFlag('ytDownloadEnabled', 'YouTube downloads are turned off.');

Router.get('/download', requireYtDownloads, optionalAuth, startDownload);
Router.get('/progress/:progressId', getProgress);
Router.get('/youtube/search', optionalAuth, searchVideos);

// Videos are uploaded to Cloudinary — no public /files static serving

module.exports = Router;
