const Router = require('express').Router()
const {getNotifications,deleteAllNotifications,postNotification,notificationView,notificationViewAll} = require('../controllers/notificationController')
const isAuth = require('../middlewares/isAuth')


Router.post('/',isAuth, postNotification)
Router.post('/view',isAuth, notificationView)
Router.post('/viewall',isAuth, notificationViewAll)
Router.get('/',getNotifications)
Router.post('/deleteall',deleteAllNotifications)

module.exports = Router;