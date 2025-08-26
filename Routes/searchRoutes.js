const Router = require('express').Router()
const {getSearchResult} = require('../controllers/searchControllers')

Router.get('/',getSearchResult)
// Router.post('/removeReact',isAuth,postRemoveReact)


module.exports = Router