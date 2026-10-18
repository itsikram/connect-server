// Per-user notification and privacy preferences from the Settings page.
// Missing rows or fields fall back to the same defaults the settings UI shows.
const { prisma } = require('./db');

const PREF_DEFAULTS = {
    connectRequestReceived: true,
    connectRequestAccepted: true,
    newMessageReceived: true,
    connectRequestReceivedEmail: false,
    connectRequestAcceptedEmail: false,
    newMessageReceivedEmail: false,
    connectRequestVisibility: 'public',
};

// Notification `type` (saveNotification) -> the push toggle that controls it.
const PUSH_PREF_BY_TYPE = {
    message: 'newMessageReceived',
    connectReq: 'connectRequestReceived',
    connectReqAccept: 'connectRequestAccepted',
};

const getUserPrefs = async (profileId) => {
    if (!profileId) return { ...PREF_DEFAULTS };
    try {
        const row = await prisma.setting.findFirst({
            where: { profile: String(profileId) },
            orderBy: { createdAt: 'asc' },
            select: Object.fromEntries(Object.keys(PREF_DEFAULTS).map((key) => [key, true])),
        });
        const prefs = { ...PREF_DEFAULTS };
        for (const key of Object.keys(PREF_DEFAULTS)) {
            if (row?.[key] !== undefined && row[key] !== null) prefs[key] = row[key];
        }
        return prefs;
    } catch (error) {
        console.warn('[notificationPrefs] using defaults:', error?.message || error);
        return { ...PREF_DEFAULTS };
    }
};

/** False when the receiver turned off push for this notification type. */
const wantsPushForType = async (profileId, type) => {
    const key = PUSH_PREF_BY_TYPE[type];
    if (!key) return true;
    const prefs = await getUserPrefs(profileId);
    return prefs[key] !== false;
};

const getProfileEmail = async (profileId) => {
    const profile = await prisma.profile.findUnique({
        where: { id: String(profileId) },
        select: { user: true },
    });
    if (!profile?.user) return '';
    const user = await prisma.user.findUnique({
        where: { id: String(profile.user) },
        select: { email: true },
    });
    return user?.email?.trim() || '';
};

module.exports = { getUserPrefs, wantsPushForType, getProfileEmail, PUSH_PREF_BY_TYPE };
