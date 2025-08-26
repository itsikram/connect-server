const Router = require("express").Router();
const {addSetting,getSetting,updateSetting} = require('../controllers/settingsController')
const isAuth = require('../middlewares/isAuth')

Router.get('/',getSetting)
Router.post('/',isAuth, addSetting)
Router.post('/update',isAuth, updateSetting)

module.exports = Router;