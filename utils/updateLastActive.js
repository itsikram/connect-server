const { prisma } = require('./db');

/**
 * Updates the lastLogin timestamp for a user based on profileId
 * and Profile.lastActive (online status itself is owned by sockets/presence.js)
 * @param {String} profileId - The profile ID
 * @returns {Promise<void>}
 */
module.exports = async (profileId) => {
    try {
        if (!profileId) {
            return;
        }

        // Find the profile to get the user ID
        const profile = await prisma.profile.findUnique({
            where: { id: String(profileId) },
            select: { id: true, user: true },
        });
        if (!profile || !profile.user) {
            return;
        }

        // Update lastLogin in User model
        await prisma.user.updateMany({
            where: { id: profile.user },
            data: { lastLogin: Date.now() },
        });

        await prisma.profile.update({
            where: { id: profile.id },
            data: { lastActive: new Date() },
        });
    } catch (error) {
        // Silently fail to not interrupt main flow
        console.error('Error updating last active time:', error);
    }
};
