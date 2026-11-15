const Router = require("express").Router();
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config();
const {getData,updateData} = require('../controllers/connectController')
const { getClientServerConfig } = require('../controllers/serverSettingsController')
const phoneCall = require('../phoneCall')
const isAdminRole = require('../middlewares/isAdminRole')
const crypto = require('crypto')
Router.get('/',getData)
// App-wide settings (APK link, maintenance mode...): admins only
Router.put('/', isAdminRole, updateData)
// Live servers the web and Expo clients should use (set in admin → Settings → Servers).
Router.get('/server-config', getClientServerConfig)

// Serve iOS configuration profile with the MIME type Safari requires
// so it appears under Settings → Profile Downloaded (not Files).
// A signed profile is DER (PKCS#7) and must start with 0x30; if a text tool
// mangled it (bytes >= 0x80 become EF BF BD), iOS says "Invalid Profile".
const isValidSignedProfile = (buf) =>
    buf.length > 4 && buf[0] === 0x30 && buf.indexOf(Buffer.from([0xef, 0xbf, 0xbd])) === -1;

Router.get('/ios-profile', (req, res) => {
    const dirs = [
        path.join(__dirname, '../public'),
        path.join(__dirname, '../build'),
        path.join(__dirname, '../../web/public'),
    ];
    let profile = null;
    for (const dir of dirs) {
        const signedPath = path.join(dir, 'connect.mobileconfig');
        if (fs.existsSync(signedPath)) {
            const buf = fs.readFileSync(signedPath);
            if (isValidSignedProfile(buf) || buf.toString('utf8', 0, 5) === '<?xml') {
                profile = buf;
                break;
            }
        }
        const unsignedPath = path.join(dir, 'connect.unsigned.mobileconfig');
        if (fs.existsSync(unsignedPath)) {
            profile = fs.readFileSync(unsignedPath);
            break;
        }
    }
    if (!profile) {
        return res.status(404).send('iOS profile not found');
    }
    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.setHeader('Content-Disposition', 'inline; filename="connect.mobileconfig"');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(profile);
});
// Places a paid phone call, so admins only.
Router.get('/phone-call', isAdminRole, (req, res) => {
    if (!phoneCall.isConfigured()) {
        return res.status(503).json({ message: 'Phone calls are not configured (INFOBIP_API_KEY)' })
    }
    if (!req.query.to) {
        return res.status(400).json({ message: 'to is required' })
    }
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
        const expected = String(process.env.GOLDUPPASS || '');
        if (!expected) {
            return res.status(503).json({
                success: false,
                message: "Password check is not configured"
            });
        }

        const a = Buffer.from(String(pass));
        const b = Buffer.from(expected);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
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