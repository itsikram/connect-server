const Router = require('express').Router()
const isAuth = require('../middlewares/isAuth')
const { reportPost, reportProfile } = require('../controllers/reportController')

Router.post('/post', isAuth, reportPost)
Router.post('/profile', isAuth, reportProfile)

module.exports = Router
