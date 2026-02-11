const Router = require("express").Router();
const dotenv = require("dotenv");

dotenv.config();
const {getData,updateData} = require('../controllers/connectController')
const phoneCall = require('../phoneCall')
Router.get('/',getData)
Router.put('/',updateData)
Router.get('/phone-call',(req, res) => {
    phoneCall.phoneCall(req.query.to, req.query.from || null, req.query.text)
    return res.status(200).json({message: 'Phone call sent'})
});
Router.get("/passcheck", async (req, res) => {
    try {
        const { pass } = req.query;

        if (!pass) {
            return res.status(400).json({
                success: false,
                message: "Password is required"
            });
        }

        if (pass === process.env.GOLDUPPASS) {
            return res.json({
                success: true,
                message: "Password matched"
            });
        } else {
            return res.status(401).json({
                success: false,
                message: "Invalid password"
            });
        }

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

module.exports = Router;