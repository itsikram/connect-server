const { loadFeatureFlags } = require('../controllers/monetizationSettingsController');

/** Rejects the request with 403 when an admin has switched the named feature flag off. */
const requireFeatureFlag = (name, message = 'This feature is turned off.') => async (req, res, next) => {
    const flags = await loadFeatureFlags();
    if (flags[name] === false) {
        return res.status(403).json({ message, featureDisabled: name });
    }
    return next();
};

module.exports = requireFeatureFlag;
