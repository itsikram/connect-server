const Router = require("express").Router();
const {signUp,login,googleSignIn,changePass,deleteAccount,changeEmail,forgotPassword,resetPassword,faceRegister,faceRemove,faceLogin} = require('../controllers/authControllers')
const isAuth = require('../middlewares/isAuth')

const faceLoginAttempts = new Map();
const faceLoginFingerprints = new Map();
const faceLoginRateLimit = (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxAttempts = 10;
    for (const [fingerprint, timestamp] of faceLoginFingerprints) {
        if (now - timestamp >= windowMs) faceLoginFingerprints.delete(fingerprint);
    }
    const frames = req.body?.frames;
    const crypto = require("crypto");
    const fingerprint = Array.isArray(frames) && frames.length > 0
        ? crypto.createHash("sha256").update(JSON.stringify(frames)).digest("hex")
        : null;
    if (fingerprint) {
        if (faceLoginFingerprints.has(fingerprint)) {
            return res.status(409).json({
                success: false,
                message: "This face capture has already been used. Please capture a new sequence.",
            });
        }
    }

    const recent = (faceLoginAttempts.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= maxAttempts) {
        const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
            success: false,
            message: `Too many face login attempts. Please try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
        });
    }

    recent.push(now);
    faceLoginAttempts.set(key, recent);
    if (fingerprint) faceLoginFingerprints.set(fingerprint, now);
    next();
};

Router.post('/signup',signUp)
Router.post('/login',login)
Router.post('/face/register', isAuth, faceRegister)
Router.post('/face/remove', isAuth, faceRemove)
Router.post('/face/login', faceLoginRateLimit, faceLogin)
Router.post('/google-signin',googleSignIn)
Router.post('/forgot-password', forgotPassword)
Router.post('/reset-password/:token', resetPassword)
Router.post('/delete', isAuth, deleteAccount)
Router.post('/changePass',isAuth,changePass)
Router.post('/changeEmail',isAuth,changeEmail)

module.exports = Router;