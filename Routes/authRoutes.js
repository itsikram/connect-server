const Router = require("express").Router();
const {signUp,login,googleSignIn,changePass,deleteAccount,changeEmail,forgotPassword,resetPassword} = require('../controllers/authControllers')
const isAuth = require('../middlewares/isAuth')

Router.post('/signup',signUp)
Router.post('/login',login)
Router.post('/google-signin',googleSignIn)
Router.post('/forgot-password', forgotPassword)
Router.post('/reset-password/:token', resetPassword)
Router.post('/delete',deleteAccount)
Router.post('/changePass',isAuth,changePass)
Router.post('/changeEmail',isAuth,changeEmail)

module.exports = Router;