const Router = require('express').Router();
const isAuth = require('../middlewares/isAuth');
const drive = require('../controllers/personalDriveController');

const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

Router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    next();
});
Router.get('/', isAuth, route(drive.status));
Router.post('/connect', isAuth, route(drive.start));
Router.get('/callback', route(drive.callback));
Router.put('/', isAuth, route(drive.update));
Router.delete('/', isAuth, route(drive.disconnect));
Router.get('/files/:id', isAuth, route(drive.download));

module.exports = Router;
