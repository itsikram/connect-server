const Router = require('express').Router()
const {postAddReact,postRemoveReact} = require('../controllers/reactControllers')
const isAuth = require('../middlewares/isAuth')

Router.post('/addReact',isAuth,postAddReact)
Router.post('/removeReact',isAuth,postRemoveReact)



module.exports = Router