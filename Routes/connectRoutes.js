const Router = require("express").Router();
const {getData,updateData} = require('../controllers/connectController')

Router.get('/',getData)
Router.put('/',updateData)

module.exports = Router;