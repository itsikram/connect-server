const Router = require("express").Router();
const {addSetting,getSetting,updateSetting} = require('../controllers/settingsController')
const isAuth = require('../middlewares/isAuth')
const multer = require('multer')

const upload = multer({ storage: multer.memoryStorage() })

Router.get('/',getSetting)
Router.post('/',isAuth, addSetting)
Router.post('/update',isAuth, upload.single('chatBackground'), updateSetting)

module.exports = Router;