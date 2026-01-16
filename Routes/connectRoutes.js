const Router = require("express").Router();
const {getData,updateData} = require('../controllers/connectController')
const phoneCall = require('../phoneCall')
Router.get('/',getData)
Router.put('/',updateData)
Router.get('/phone-call',(req, res) => {
    phoneCall.phoneCall(req.query.to, req.query.from || null, req.query.text)
    return res.status(200).json({message: 'Phone call sent'})
})

module.exports = Router;