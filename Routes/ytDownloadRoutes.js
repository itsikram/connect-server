const Router = require('express').Router();
const express = require('express');
const path = require('path');
const optionalAuth = require('../middlewares/optionalAuth');
const { startDownload, getProgress } = require('../controllers/ytDownloadController');
const { DOWNLOAD_DIR } = require('../services/ytDownloadService');

Router.get('/download', optionalAuth, startDownload);
Router.get('/progress/:progressId', getProgress);
Router.use('/files', express.static(DOWNLOAD_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.mp4')) {
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', 'attachment');
        }
    },
}));

module.exports = Router;
