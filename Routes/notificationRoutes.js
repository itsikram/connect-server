const Router = require('express').Router()
const {getNotifications,deleteAllNotifications,postNotification,notificationView,notificationViewAll, registerDeviceToken, unregisterDeviceToken, sendTestPush} = require('../controllers/notificationController')
const isAuth = require('../middlewares/isAuth')


Router.post('/',isAuth, postNotification)
Router.post('/view',isAuth, notificationView)
Router.post('/token/register', isAuth, registerDeviceToken)
Router.post('/token/unregister', isAuth, unregisterDeviceToken)
Router.post('/send-test', isAuth, sendTestPush)
Router.post('/viewall',isAuth, notificationViewAll)
Router.get('/',isAuth,getNotifications)
Router.post('/deleteall',deleteAllNotifications)

module.exports = Router;