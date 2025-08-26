const Router = require("express").Router();
const {signUp,login,changePass,deleteAccount,changeEmail} = require('../controllers/authControllers')
const isAuth = require('../middlewares/isAuth')

Router.post('/signup',signUp)
Router.post('/login',login)
Router.post('/delete',deleteAccount)
Router.post('/changePass',isAuth,changePass)
Router.post('/changeEmail',isAuth,changeEmail)

module.exports = Router;