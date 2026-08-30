const User = require('../models/User');
const Profile = require('../models/Profile');

/**
 * Updates the lastLogin timestamp for a user based on profileId
 * Also updates isActive status to true
 * @param {String} profileId - The profile ID
 * @returns {Promise<void>}
 */
module.exports = async (profileId) => {
    try {
        if (!profileId) {
            return;
        }

        // Find the profile to get the user ID
        const profile = await Profile.findById(profileId).select('user');
        if (!profile || !profile.user) {
            return;
        }

        // Update lastLogin in User model
        await User.findByIdAndUpdate(
            profile.user,
            { lastLogin: Date.now() },
            { new: false }
        );

        // Update isActive status to true
        await Profile.findByIdAndUpdate(
            profileId,
            { isActive: true, lastActive: new Date() },
            { new: false }
        );
    } catch (error) {
        // Silently fail to not interrupt main flow
        console.error('Error updating last active time:', error);
    }
};
