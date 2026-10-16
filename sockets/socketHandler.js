// server/socketHandler.js
const messageSocket = require('./messageSocket');
const { notificationSocket } = require('../controllers/notificationController');
const { prisma, isValidId } = require('../utils/db');
const { isMySQLReady } = require('../config/prisma');
const updateLastActive = require('../utils/updateLastActive');
const callingSocket = require('./callingSocket');
const { sendBump } = require('../utils/sendBump');
const ludoSocket = require('./ludoSocket');
const chessSocket = require('./chessSocket');
const presence = require('./presence');
const { createSocketAuth } = require('./socketAuth');

// Profile.connects (join table) -> connect profile ids.
async function connectIdsOf(profileId) {
    if (!isValidId(profileId)) return [];
    const rows = await prisma.profileConnect.findMany({
        where: { profile: String(profileId) },
        select: { connect: true },
    });
    return rows.map((row) => row.connect);
}

module.exports = function socketHandler(io) {
    // Verify each connection's access token before 'connection' fires; the
    // socket's identity is the token's profile (see socketAuth.js).
    io.use(createSocketAuth().middleware);

    // profileId -> socketId
    const onlineUsers = new Map();
    // profileId -> Set of socketIds (to track multiple connections per user)
    const profileSockets = new Map();

    io.on('connection', async (socket) => {
        // Set by the auth middleware: the verified profile (or, in grace
        // mode, the claimed one); null for anonymous sockets.
        const profileId = socket.data?.profileId || null;
        const browserId = socket.handshake.query?.browserId;

        console.info('[realtime_socket_connected]', {
            socketId: socket.id,
            profileId: profileId || null,
            browserId: browserId || null,
            transport: socket.conn?.transport?.name || null,
        });

        if (profileId && profileId !== 'undefined') {
            socket.join(String(profileId));
            console.info('[realtime_socket_room_joined]', {
                socketId: socket.id,
                profileId: String(profileId),
                roomSize: io.sockets.adapter.rooms.get(String(profileId))?.size || 0,
            });
            
            // Track multiple socket connections per profile
            if (!profileSockets.has(profileId)) {
                profileSockets.set(profileId, new Set());
            }
            profileSockets.get(profileId).add(socket.id);
            onlineUsers.set(profileId, socket.id);

            // Join browser-specific room if browserId is provided
            if (browserId && browserId !== 'undefined') {
                socket.join(`browser_${browserId}`);
            }

            // Register every event handler synchronously, BEFORE any awaited
            // database work. Clients emit (sendMessage, audio-call, joinRoom,
            // answer-call...) immediately after the connect acknowledgement;
            // handlers registered after an await silently dropped those
            // events, and none were registered at all while MongoDB was
            // still connecting.
            try {
                messageSocket(io, socket, profileId);
                notificationSocket(io, socket, profileId);
                callingSocket(io, socket, profileId, onlineUsers);
                ludoSocket(io, socket, profileId);
                chessSocket(io, socket, profileId);
            } catch (err) {
                console.error('Error initializing message/notification sockets:', err);
            }

            // Realtime presence: per-socket tracking, instant broadcast to
            // connects, initial status snapshot for this client.
            presence.attachSocket(io, socket, profileId);
        } else {
            // Anonymous sockets may still subscribe to statuses.
            presence.attachSocket(io, socket, null);
        }

        // View post tracking
        socket.on('viewPost', async ({ visitorId, postId }) => {
            try {
                if (isValidId(postId) && isValidId(visitorId)) {
                    const postExists = await prisma.post.count({ where: { id: String(postId) } });
                    if (postExists) {
                        await prisma.postViewer.createMany({
                            data: [{ post: String(postId), profile: String(visitorId) }],
                            skipDuplicates: true,
                        });
                    }
                }
                // Update last active time for viewing posts
                await updateLastActive(visitorId);
            } catch (err) {
                console.error('Error updating post viewers:', err);
            }
        });

        // bump notification
        socket.on('bump', async ({ connectProfile, myProfile }) => {
            try {
                const fromId = myProfile || profileId;
                await sendBump(io, { connectProfile, myProfile: fromId });
            } catch (err) {
                console.error('bump emit error', err);
            }
        });

        // Check active status
        socket.on('is_active', async ({ profileId: targetProfileId, myId }) => {
            if (!targetProfileId || targetProfileId.length < 5) return;
            try {
                const statuses = await presence.getStatuses([targetProfileId]);
                const status = statuses[String(targetProfileId)] || { isActive: false, lastSeen: null };
                const lastSeen = status.lastSeen ? new Date(status.lastSeen).getTime() : null;
                socket.emit('is_active', status.isActive, lastSeen, targetProfileId);
            } catch (err) {
                console.error('Error checking active status:', err);
                socket.emit('is_active', false, null, targetProfileId);
            }
        });

        // Location update handler
        socket.on('location_update', async ({ profileId: senderProfileId, location }) => {
            try {
                if (!senderProfileId || !location) {
                    console.error('Invalid location_update data:', { senderProfileId, location });
                    return;
                }

                // Update profile location in database
                const updated = isValidId(senderProfileId)
                    ? await prisma.profile.updateMany({
                        where: { id: String(senderProfileId) },
                        data: {
                            lastLocation: {
                                latitude: location.latitude,
                                longitude: location.longitude,
                                timestamp: location.timestamp || Date.now(),
                                accuracy: location.accuracy,
                            }
                        },
                    })
                    : { count: 0 };

                if (!updated.count) {
                    console.error('Profile not found for location update:', senderProfileId);
                    return;
                }

                // Update last active time for location update
                await updateLastActive(senderProfileId);

                // Get user's connects to broadcast location update
                const profile = { connects: await connectIdsOf(senderProfileId) };
                if (profile && profile.connects && profile.connects.length > 0) {
                    console.log('📍 Broadcasting location update to', profile.connects.length, 'connects');
                    // Emit location update to all connects
                    profile.connects.forEach(connectId => {
                        const connectIdStr = String(connectId);
                        const locationUpdateData = {
                            profileId: senderProfileId,
                            location: {
                                latitude: location.latitude,
                                longitude: location.longitude,
                                timestamp: location.timestamp || Date.now(),
                                accuracy: location.accuracy,
                            }
                        };
                        io.to(connectIdStr).emit('connect_location_update', locationUpdateData);
                        console.log('📍 Location update sent to connect room:', connectIdStr, 'for profile:', senderProfileId);
                    });
                } else {
                    console.log('📍 No connects found for profile:', senderProfileId);
                }

                console.log('📍 Location updated for profile:', senderProfileId);
            } catch (err) {
                console.error('Error handling location_update:', err);
            }
        });

        // Disconnect
        socket.on('disconnect', async () => {
            console.log(`🔌 Socket disconnected: ${socket.id}`, {
                profileId: profileId || null,
                reason: 'client_or_transport_disconnect',
            });

            // Online/offline is handled by presence.attachSocket; only the
            // call routing map is maintained here.
            if (profileId && profileId !== 'undefined') {
                const sockets = profileSockets.get(profileId);
                if (sockets) {
                    sockets.delete(socket.id);
                    if (sockets.size === 0) profileSockets.delete(profileId);
                }
                if (profileSockets.has(profileId)) {
                    const [remainingSocketId] = profileSockets.get(profileId);
                    onlineUsers.set(profileId, remainingSocketId);
                } else {
                    onlineUsers.delete(profileId);
                }
            }
        });
    });
};
