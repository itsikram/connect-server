const { prisma } = require('./db');

// Typing, sending and "seen" events call this constantly. Online status is
// owned by sockets/presence.js (which refreshes lastActive every minute for
// online profiles) and isAuth already writes presence at most once a minute,
// so write here at most once a minute per profile too, instead of three
// queries on every keystroke burst.
const WRITE_INTERVAL_MS = 60 * 1000;
const lastWrite = new Map();

const shouldWrite = (profileId) => {
    const now = Date.now();
    if (now - (lastWrite.get(profileId) || 0) < WRITE_INTERVAL_MS) return false;
    lastWrite.set(profileId, now);
    if (lastWrite.size > 50000) lastWrite.clear();
    return true;
};

/**
 * Updates the lastLogin timestamp for a user based on profileId
 * and Profile.lastActive (online status itself is owned by sockets/presence.js)
 * @param {String} profileId - The profile ID
 * @returns {Promise<void>}
 */
module.exports = async (profileId) => {
    try {
        if (!profileId || !shouldWrite(String(profileId))) {
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

        await Promise.all([
            // Update lastLogin in User model
            prisma.user.updateMany({
                where: { id: profile.user },
                data: { lastLogin: Date.now() },
            }),
            prisma.profile.update({
                where: { id: profile.id },
                data: { lastActive: new Date() },
            }),
        ]);
    } catch (error) {
        // Silently fail to not interrupt main flow
        console.error('Error updating last active time:', error);
    }
};
