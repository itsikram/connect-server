const Router = require("express").Router();
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config();
const {getData,updateData} = require('../controllers/connectController')
const phoneCall = require('../phoneCall')
Router.get('/',getData)
Router.put('/',updateData)

// Serve iOS configuration profile with the MIME type Safari requires
// so it appears under Settings → Profile Downloaded (not Files).
Router.get('/ios-profile', (req, res) => {
    const candidates = [
        path.join(__dirname, '../public/connect.mobileconfig'),
        path.join(__dirname, '../build/connect.mobileconfig'),
        path.join(__dirname, '../../web/public/connect.mobileconfig'),
    ];
    const filePath = candidates.find((p) => fs.existsSync(p));
    if (!filePath) {
        return res.status(404).send('iOS profile not found');
    }
    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.setHeader('Content-Disposition', 'inline; filename="connect.mobileconfig"');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.resolve(filePath));
});
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
        console.log('passes',pass, process.env.GOLDUPPASS)

        if (pass === (process.env.GOLDUPPASS || 'testpass000')) {
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