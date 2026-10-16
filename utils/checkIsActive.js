const { prisma, isValidId } = require('./db')

module.exports = async (profileId, userId = null) => {
    let isActive = false

    let userLastLogin;

    if (isValidId(userId)) {
        let user = await prisma.user.findUnique({
            where: { id: String(userId) },
            select: { id: true, lastLogin: true },
        });

        if (user?.lastLogin) {
            userLastLogin = user.lastLogin;
        }

    } else if (isValidId(profileId)) {
        const profile = await prisma.profile.findUnique({
            where: { id: String(profileId) },
            select: { id: true, userDoc: { select: { id: true, lastLogin: true } } },
        });

        if (profile?.userDoc?.lastLogin) {
            userLastLogin = profile.userDoc.lastLogin;
        }
    }


    let currentTime = Date.now();
    const fiveMinutes = (5 * 60 * 1000);
    const diff = Math.abs(userLastLogin - currentTime);



    if (diff > fiveMinutes) {
        isActive = false
    } else {
        isActive = true
    }

    return {
        isActive,
        lastLogin: userLastLogin
    }

}
