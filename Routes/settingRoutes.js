const Router = require("express").Router();
const {addSetting,getSetting,updateSetting} = require('../controllers/settingsController')
const isAuth = require('../middlewares/isAuth')
const multer = require('multer')
const { cacheResponse, GRAPH_TAGS, CONTENT_TAGS, MESSAGE_TAGS, NOTIFICATION_TAGS } = require('../utils/cacheResponse')

const upload = multer({ storage: multer.memoryStorage() })

Router.get('/',cacheResponse({ ttl: 60, tags: ['Setting'] }),getSetting)
Router.post('/',isAuth, addSetting)
Router.post('/update',isAuth, upload.single('chatBackground'), updateSetting)

module.exports = Router;