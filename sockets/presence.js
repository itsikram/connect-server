// server/sockets/presence.js
//
// Realtime online/offline status. The live sockets are the source of truth:
// a profile is online while at least one of its sockets (web tab, phone,
// Expo web...) is connected and not "away" (app in background). Changes are
// broadcast immediately to the `presence:<profileId>` room, which every
// connect of that profile (and anyone who subscribed, e.g. an open chat)
// joins, and mirrored to Profile.isActive / lastActive so HTTP endpoints and
// sibling servers agree.
//
// Client -> server:
//   presence:subscribe  { profileIds: [], connects?: true } -> ack/emit presence_snapshot
//   presence:away       (app backgrounded / tab hidden for long)
//   presence:active     (app foregrounded / tab visible)
//   presence:focus      { focused } (app in foreground / tab visible and
//                       focused; while any socket is focused, pushes are
//                       skipped, see isProfileFocused)
// Server -> client:
//   presence_update     { profileId, isActive, lastSeen }
//   presence_snapshot   { statuses: { [profileId]: { isActive, lastSeen } } }
//   connect_online / connect_offline { profileId }   (legacy)

const { prisma, isValidId } = require('../utils/db');
const { isMySQLReady } = require('../config/prisma');

// A dropped transport (tab closed, page reload, network blip) waits this long
// before going offline so reloads / quick reconnects don't flicker.
const DISCONNECT_GRACE_MS = 3000;
// Online profiles refresh lastActive this often; a DB "isActive" older than
// DB_STALE_MS is ignored (covers a server that died without cleanup).
const HEARTBEAT_MS = 60 * 1000;
const DB_STALE_MS = 3 * 60 * 1000;
const MAX_SUBSCRIBE_IDS = 500;

const room = (profileId) => `presence:${profileId}`;

// profileId -> Map<socketId, { away: boolean, focused: boolean }>
const localSockets = new Map();
// profileId -> last state we published (true/false)
const published = new Map();
// profileId -> lastSeen Date (set when going offline)
const lastSeenAt = new Map();
// profileId -> pending offline timer
const offlineTimers = new Map();

let ioRef = null;

const isLocallyOnline = (profileId) => {
    const sockets = localSockets.get(String(profileId));
    if (!sockets) return false;
    for (const state of sockets.values()) {
        if (!state.away) return true;
    }
    return false;
};

// True while the user is looking at the app on some device/tab connected to
// this server. Sockets that never report focus (older clients) count as not
// focused, so they keep getting pushes.
const isProfileFocused = (profileId) => {
    const sockets = profileId ? localSockets.get(String(profileId)) : null;
    if (!sockets) return false;
    for (const state of sockets.values()) {
        if (state.focused && !state.away) return true;
    }
    return false;
};

const isDbProfileOnline = (profile) => {
    if (!profile || !profile.isActive) return false;
    const lastActive = profile.lastActive ? new Date(profile.lastActive).getTime() : 0;
    return Boolean(lastActive && Date.now() - lastActive < DB_STALE_MS);
};

// Status for a profile row ({ id, isActive, lastActive }) preferring what
// this server knows from live sockets.
const statusFromProfile = (profile) => {
    const id = String(profile?.id || profile?._id || '');
    if (id && localSockets.has(id)) {
        const online = isLocallyOnline(id);
        return {
            isActive: online,
            lastSeen: online ? new Date() : (lastSeenAt.get(id) || profile.lastActive || null),
        };
    }
    if (id && published.get(id) === false && lastSeenAt.has(id)) {
        // Went offline here moments ago; DB write may still be in flight.
        return { isActive: false, lastSeen: lastSeenAt.get(id) };
    }
    return {
        isActive: isDbProfileOnline(profile),
        lastSeen: profile?.lastActive || null,
    };
};

async function connectIdsOf(profileId) {
    if (!isValidId(profileId) || !isMySQLReady()) return [];
    const rows = await prisma.profileConnect.findMany({
        where: { profile: String(profileId) },
        select: { connect: true },
    });
    return rows.map((row) => String(row.connect));
}

async function getStatuses(profileIds) {
    const ids = [...new Set((profileIds || []).map(String).filter((id) => isValidId(id)))];
    const statuses = {};
    if (!ids.length) return statuses;
    let rows = [];
    if (isMySQLReady()) {
        try {
            rows = await prisma.profile.findMany({
                where: { id: { in: ids } },
                select: { id: true, isActive: true, lastActive: true },
            });
        } catch (err) {
            console.error('[presence] status lookup failed:', err.message);
        }
    }
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    ids.forEach((id) => {
        statuses[id] = statusFromProfile(byId.get(id) || { id, isActive: false, lastActive: null });
    });
    return statuses;
}

const writeDb = (profileId, isActive) => {
    if (!isMySQLReady() || !isValidId(profileId)) return;
    prisma.profile
        .updateMany({
            where: { id: String(profileId) },
            data: { isActive, lastActive: new Date() },
        })
        .catch((err) => console.error('[presence] db write failed:', err.message));
    if (isActive) {
        prisma.user
            .updateMany({ where: { profile: String(profileId) }, data: { lastLogin: Date.now() } })
            .catch(() => {});
    }
};

const broadcast = (profileId, isActive) => {
    if (!ioRef) return;
    const id = String(profileId);
    const lastSeen = isActive ? new Date() : (lastSeenAt.get(id) || new Date());
    const payload = { profileId: id, isActive, lastSeen };
    ioRef.to(room(id)).emit('presence_update', payload);
    ioRef.to(room(id)).emit(isActive ? 'connect_online' : 'connect_offline', { profileId: id });
    // The user's other devices/tabs, so a "you are online" indicator can sync.
    ioRef.to(id).emit('presence_update', payload);
};

const publish = (profileId, isActive) => {
    const id = String(profileId);
    if (published.get(id) === isActive) return;
    published.set(id, isActive);
    if (!isActive) lastSeenAt.set(id, new Date());
    console.info('[presence]', id, isActive ? 'online' : 'offline');
    writeDb(id, isActive);
    broadcast(id, isActive);
    if (!isActive && !localSockets.has(id)) {
        // Nothing left to track for this profile on this server.
        setTimeout(() => {
            if (!localSockets.has(id)) published.delete(id);
        }, DB_STALE_MS).unref?.();
    }
};

const cancelOffline = (profileId) => {
    const timer = offlineTimers.get(profileId);
    if (timer) {
        clearTimeout(timer);
        offlineTimers.delete(profileId);
    }
};

// Re-evaluate a profile after any socket change.
const reconcile = (profileId, { graceMs = 0 } = {}) => {
    const id = String(profileId);
    if (isLocallyOnline(id)) {
        cancelOffline(id);
        publish(id, true);
        return;
    }
    if (offlineTimers.has(id)) {
        if (graceMs > 0) return; // already counting down
        cancelOffline(id);
    }
    if (graceMs > 0) {
        offlineTimers.set(
            id,
            setTimeout(() => {
                offlineTimers.delete(id);
                if (!isLocallyOnline(id)) publish(id, false);
            }, graceMs),
        );
    } else {
        publish(id, false);
    }
};

const subscribe = async (socket, profileIds) => {
    const ids = [...new Set((profileIds || []).map(String).filter((id) => isValidId(id)))]
        .slice(0, MAX_SUBSCRIBE_IDS);
    ids.forEach((id) => socket.join(room(id)));
    const statuses = await getStatuses(ids);
    return statuses;
};

function attachSocket(io, socket, profileId) {
    ioRef = io;
    const id = profileId ? String(profileId) : null;

    if (id) {
        if (!localSockets.has(id)) localSockets.set(id, new Map());
        const initiallyAway = String(socket.handshake.query?.presence || socket.handshake.auth?.presence || '') === 'away';
        localSockets.get(id).set(socket.id, { away: initiallyAway, focused: false });
        // This socket learns about its own profile's changes too.
        socket.join(room(id));
        reconcile(id);

        // Watch every connect and send the current snapshot.
        connectIdsOf(id)
            .then((connectIds) => subscribe(socket, connectIds))
            .then((statuses) => {
                if (socket.connected) socket.emit('presence_snapshot', { statuses });
            })
            .catch((err) => console.error('[presence] initial snapshot failed:', err.message));

        const setAway = (away) => {
            const state = localSockets.get(id)?.get(socket.id);
            if (!state || state.away === away) return;
            state.away = away;
            reconcile(id);
        };
        socket.on('presence:away', () => setAway(true));
        socket.on('presence:active', () => setAway(false));
        socket.on('presence:focus', (payload) => {
            const state = localSockets.get(id)?.get(socket.id);
            if (state) state.focused = payload === true || payload?.focused === true;
        });
    }

    socket.on('presence:subscribe', async (payload, ack) => {
        try {
            let ids = Array.isArray(payload) ? payload : payload?.profileIds || [payload?.profileId];
            // { connects: true } also (re)watches all of this profile's connects.
            if (id && payload?.connects) ids = [...(ids || []), ...(await connectIdsOf(id))];
            const statuses = await subscribe(socket, ids);
            if (typeof ack === 'function') ack({ statuses });
            else socket.emit('presence_snapshot', { statuses });
        } catch (err) {
            console.error('[presence] subscribe failed:', err.message);
            if (typeof ack === 'function') ack({ statuses: {} });
        }
    });

    socket.on('presence:unsubscribe', (payload) => {
        const ids = Array.isArray(payload) ? payload : payload?.profileIds || [];
        ids.forEach((pid) => {
            if (String(pid) !== id) socket.leave(room(String(pid)));
        });
    });

    socket.on('disconnect', (reason) => {
        if (!id) return;
        const sockets = localSockets.get(id);
        if (sockets) {
            sockets.delete(socket.id);
            if (sockets.size === 0) localSockets.delete(id);
        }
        // An explicit client disconnect (logout) is final; a dropped
        // transport may just be a reload or network blip.
        const explicit = reason === 'client namespace disconnect' || reason === 'server namespace disconnect';
        reconcile(id, { graceMs: explicit ? 0 : DISCONNECT_GRACE_MS });
    });
}

// Keep lastActive fresh for everyone online here, so the DB view (used by
// HTTP endpoints and sibling servers) never goes stale.
const heartbeat = setInterval(() => {
    if (!isMySQLReady()) return;
    const ids = [...localSockets.keys()].filter((pid) => isLocallyOnline(pid) && isValidId(pid));
    for (let i = 0; i < ids.length; i += 500) {
        prisma.profile
            .updateMany({
                where: { id: { in: ids.slice(i, i + 500) } },
                data: { isActive: true, lastActive: new Date() },
            })
            .catch((err) => console.error('[presence] heartbeat failed:', err.message));
    }
}, HEARTBEAT_MS);
heartbeat.unref?.();

module.exports = {
    attachSocket,
    getStatuses,
    statusFromProfile,
    isDbProfileOnline,
    isLocallyOnline,
    isProfileFocused,
};
