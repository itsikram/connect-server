const Router = require('express').Router();
const {
    getTimerSession,
    updateTimerSession
} = require('../controllers/timerController');
const isAuth = require('../middlewares/isAuth');

Router.get('/', isAuth, getTimerSession);
Router.post('/update', isAuth, updateTimerSession);

module.exports = Router;
