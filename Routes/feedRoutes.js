const Router = require('express').Router();
const isAuth = require('../middlewares/isAuth');
const { getRankedPosts, getRankedWatches } = require('../controllers/feedController');

Router.get('/posts', isAuth, getRankedPosts);
Router.get('/watches', isAuth, getRankedWatches);

module.exports = Router;
