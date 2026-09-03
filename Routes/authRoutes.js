const Router = require("express").Router();
const {signUp,login,googleSignIn,changePass,deleteAccount,changeEmail,forgotPassword,resetPassword,faceRegister,faceLogin} = require('../controllers/authControllers')
const isAuth = require('../middlewares/isAuth')

const faceLoginAttempts = new Map();
const faceLoginFingerprints = new Map();
const faceLoginRateLimit = (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxAttempts = 5;
    const recent = (faceLoginAttempts.get(key) || []).filter((timestamp) => now - timestamp < windowMs);

    if (recent.length >= maxAttempts) {
        return res.status(429).json({
            success: false,
            message: 'Too many face login attempts. Please try again later.',
        });
    }

    recent.push(now);
    faceLoginAttempts.set(key, recent);
    for (const [fingerprint, timestamp] of faceLoginFingerprints) {
        if (now - timestamp >= windowMs) faceLoginFingerprints.delete(fingerprint);
    }
    const frames = req.body?.frames;
    if (Array.isArray(frames) && frames.length > 0) {
        const crypto = require("crypto");
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify(frames)).digest("hex");
        if (faceLoginFingerprints.has(fingerprint)) {
            return res.status(409).json({
                success: false,
                message: "This face capture has already been used. Please capture a new sequence.",
            });
        }
        faceLoginFingerprints.set(fingerprint, now);
    }
    next();
};

Router.post('/signup',signUp)
Router.post('/login',login)
Router.post('/face/register', isAuth, faceRegister)
Router.post('/face/login', faceLoginRateLimit, faceLogin)
Router.post('/google-signin',googleSignIn)
Router.post('/forgot-password', forgotPassword)
Router.post('/reset-password/:token', resetPassword)
Router.post('/delete', isAuth, deleteAccount)
Router.post('/changePass',isAuth,changePass)
Router.post('/changeEmail',isAuth,changeEmail)

module.exports = Router;