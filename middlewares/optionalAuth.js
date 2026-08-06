const jwt = require('jsonwebtoken');
const Profile = require('../models/Profile');

const SECRET_KEY = process.env.JWT_SECRET_KEY;

/** Sets req.profile when a valid token is present; does not reject missing/invalid tokens. */
const optionalAuth = async (req, res, next) => {
    try {
        const token = req.headers.authorization;
        if (!token) {
            return next();
        }

        const { user_id } = jwt.verify(token, SECRET_KEY);
        const profileData = await Profile.findOne({ user: user_id }).populate('user');
        if (profileData) {
            req.profile = profileData;
        }
    } catch (_) {
        // Ignore invalid/expired tokens for optional auth
    }
    next();
};

module.exports = optionalAuth;
