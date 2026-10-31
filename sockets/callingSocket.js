const { prisma, populated } = require('../utils/db')

// Name + picture of a profile (null when there is no such profile).
const findCallProfile = (id) =>
    id
        ? prisma.profile.findUnique({ where: { id: String(id) }, select: { id: true, fullName: true, profilePic: true } })
        : Promise.resolve(null)
const { sendPushToProfile } = require('../utils/pushNotifications')
const { sendWebPushToProfile } = require('../utils/webPush')
const { getIncomingCallAlertForProfile } = require('../utils/ringtone')
const { peerServersConfigured } = require('../utils/peerSocketAdapter')
const config = require('../config/config.json');

// How long an unanswered call rings before it becomes a missed call.
const RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS) || 60000;
// Accepted calls whose end event never arrived (app killed, network lost) are
// dropped after this long so the registry cannot grow without bound.
const STALE_CALL_MS = 6 * 60 * 60 * 1000;
// How long a ringing call survives its caller's socket disconnecting.
const CALLER_DISCONNECT_GRACE_MS = Number(process.env.CALLER_DISCONNECT_GRACE_MS) || 10000;

// Call state MUST be shared by every socket. The caller and callee are on
// different sockets (often different platforms: web / Expo), so per-socket
// state meant the callee's answer never cleared the caller's missed-call
// timer and the caller never knew the call had been accepted.
//
// channelName -> {
//   channelName, callerId, calleeId, callerSocketId, isAudio,
//   accepted, answeredSocketId, createdAt, acceptedAt, timer, logged
// }
const activeCalls = new Map();
// Fallback dedupe for call-log messages when no call record exists
// (e.g. the server restarted mid-call). key -> timestamp
const recentCallLogs = new Map();
// channelName -> timestamp for calls that already finished, so a late
// duplicate cancel/end (some clients send both) does not re-push or re-log.
const finishedCalls = new Map();

const callTypeOf = (isAudio) => (isAudio ? 'audio' : 'video');
const getRoomKey = (a, b) => [String(a), String(b)].sort().join('_');

const pruneStaleCalls = () => {
    const now = Date.now();
    for (const [channelName, call] of activeCalls.entries()) {
        if (now - call.createdAt > STALE_CALL_MS) {
            if (call.timer) clearTimeout(call.timer);
            activeCalls.delete(channelName);
        }
    }
    for (const [key, ts] of recentCallLogs.entries()) {
        if (now - ts > 30000) recentCallLogs.delete(key);
    }
    for (const [key, ts] of finishedCalls.entries()) {
        if (now - ts > 60000) finishedCalls.delete(key);
    }
};

const clearCallTimer = (call) => {
    if (call?.timer) {
        clearTimeout(call.timer);
        call.timer = null;
    }
};

const removeCall = (channelName) => {
    const call = activeCalls.get(channelName);
    if (call) {
        clearCallTimer(call);
        finishedCalls.set(String(channelName), Date.now());
    }
    activeCalls.delete(channelName);
    return call;
};

const wasFinished = (channelName) => !!channelName && finishedCalls.has(String(channelName));

const roomHasSockets = (io, room) => (io.sockets.adapter.rooms.get(String(room))?.size || 0) > 0;

const isParticipant = (call, profileId) =>
    !!call && (call.callerId === String(profileId) || call.calleeId === String(profileId));

// Another live call that `profileId` is part of (other than `exceptChannel`).
// A ringing call always counts. An accepted call only counts while the other
// participant is still connected, so a call whose end event never arrived
// (app killed mid-call) cannot leave someone "busy" for hours.
const findBusyCall = (io, profileId, exceptChannel) => {
    const id = String(profileId);
    for (const call of activeCalls.values()) {
        if (call.channelName === String(exceptChannel)) continue;
        if (call.callerId !== id && call.calleeId !== id) continue;
        if (!call.accepted) return call;
        const peer = call.callerId === id ? call.calleeId : call.callerId;
        if (roomHasSockets(io, peer)) return call;
    }
    return null;
};

// The call a client event refers to, if `me` takes part in it. Clients send
// the channelName of their call; an event for a channel that is not (or no
// longer) registered is a late event of an earlier call and must not touch
// the call the same two people are in now. Only events without a channel
// (very old clients) fall back to the most recent call between the pair.
const findCall = (channelName, me, other) => {
    if (channelName) {
        const call = activeCalls.get(String(channelName)) || null;
        return isParticipant(call, me) ? call : null;
    }
    if (!me || !other) return null;
    let latest = null;
    for (const call of activeCalls.values()) {
        const samePair =
            (call.callerId === String(me) && call.calleeId === String(other)) ||
            (call.callerId === String(other) && call.calleeId === String(me));
        if (samePair && (!latest || call.createdAt > latest.createdAt)) latest = call;
    }
    return latest;
};

async function sendIncomingCallWebPush(to, {
    isAudio,
    callerId,
    callerName,
    callerProfilePic,
    channelName,
}) {
    const audio = !!isAudio;
    const name = callerName || 'Someone';
    const alert = await getIncomingCallAlertForProfile(to);
    return sendWebPushToProfile(to, {
        title: audio ? 'Incoming audio call' : 'Incoming video call',
        body: `${name} is calling`,
        icon: callerProfilePic || '/apple-touch-icon.png',
        link: `/message/${callerId}`,
        type: 'incoming_call',
        tag: `incoming-call-${channelName || Date.now()}`,
        requireInteraction: true,
        urgency: 'high',
        ttl: 120, // ring window — don't deliver stale calls hours later
        silent: false,
        sound: alert.webSrc,
        vibrate: [300, 100, 300, 100, 300],
        actions: [
            { action: 'accept_call', title: 'Accept' },
            { action: 'reject_call', title: 'Reject' },
        ],
        data: {
            type: 'incoming_call',
            isAudio: audio ? 'true' : 'false',
            callerId: String(callerId),
            callerName: name,
            callerProfilePic: callerProfilePic || '',
            channelName: channelName || '',
            ringtoneId: String(alert.id),
            ringtoneSrc: alert.webSrc,
            url: `/message/${callerId}`,
            link: `/message/${callerId}`,
        },
    });
}

async function sendMissedCallPush(calleeId, callerId, isAudio, channelName) {
    const label = isAudio ? 'audio' : 'video';
    const article = isAudio ? 'an' : 'a';
    let callerName = '';
    try {
        callerName = (await findCallProfile(callerId))?.fullName || '';
    } catch (e) { }
    const body = callerName ? `${callerName} tried to reach you` : `You missed ${article} ${label} call`;
    try {
        await sendPushToProfile(calleeId, {
            title: `Missed ${label} call`,
            body,
            // callerId/senderId let the app open the right chat on tap.
            data: {
                type: 'missed_call',
                isVideo: isAudio ? 'false' : 'true',
                callerId: String(callerId),
                senderId: String(callerId),
                channelName: String(channelName || ''),
            }
        });
    } catch (e) { }
    try {
        await sendWebPushToProfile(calleeId, {
            title: `Missed ${label} call`,
            body,
            type: 'missed_call',
            tag: `missed-call-${channelName || Date.now()}`,
            link: `/message/${callerId}`,
            data: {
                type: 'missed_call',
                isVideo: isAudio ? 'false' : 'true',
                callerId: String(callerId),
                senderId: String(callerId),
                channelName: String(channelName || ''),
                url: `/message/${callerId}`,
            },
        });
    } catch (e) { }
}

// Persist a call-log chat message and deliver it to both participants on
// every device. io.to([...rooms]) delivers once per socket even when a
// socket is in several of the rooms.
async function logCallMessage(io, { callerId, calleeId, isAudio, callEvent, duration, call }) {
    const callType = callTypeOf(isAudio);
    const key = `${getRoomKey(callerId, calleeId)}:${callType}`;
    if (call) {
        if (call.logged) return;
        call.logged = true;
    } else {
        const last = recentCallLogs.get(key) || 0;
        if (Date.now() - last < 10000) return;
    }
    recentCallLogs.set(key, Date.now());

    try {
        const room = getRoomKey(callerId, calleeId);
        const label = isAudio ? 'audio' : 'video';
        const message = callEvent === 'missed'
            ? `Missed ${label} call`
            : `${isAudio ? 'Audio' : 'Video'} call ended`;
        const updatedMessage = populated(
            await prisma.message.create({
                data: {
                    room,
                    senderId: String(callerId),
                    receiverId: String(calleeId),
                    message,
                    messageType: 'call',
                    callType,
                    callEvent,
                    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
                },
                include: { parentDoc: true },
            }),
            'parent'
        );
        const senderProfile = callerId
            ? populated(
                await prisma.profile.findUnique({
                    where: { id: String(callerId) },
                    omit: { deviceTokens: true, browserIds: true, webPushSubscriptions: true },
                    include: { userDoc: { omit: { password: true, resetPasswordToken: true, resetPasswordExpire: true } } },
                }),
                'user'
            )
            : null;
        const senderName = `${senderProfile?.user?.firstName || ''} ${senderProfile?.user?.surname || ''}`.trim();
        const senderPP = senderProfile?.profilePic || config?.defaultProfile;
        io.to([room, String(callerId), String(calleeId)]).emit('newMessage', {
            updatedMessage, senderName, senderPP, chatPage: true, isRealTime: true,
        });
        io.to([String(callerId), String(calleeId)]).emit('newMessageToUser', {
            updatedMessage, senderName, senderPP, chatPage: false, connectProfile: senderProfile, isRealTime: true,
        });
    } catch (err) {
        console.error('Failed to log call message:', err?.message || err);
    }
}

// Close a call this server holds after it ended somewhere else (another
// server, see applyCallSync): send the missed-call push and write the log.
async function closeCallRecord(io, call, reason) {
    removeCall(call.channelName);
    const accepted = !!call.accepted;
    if (!accepted && reason !== 'declined') {
        await sendMissedCallPush(call.calleeId, call.callerId, call.isAudio, call.channelName);
    }
    const duration = accepted && call.acceptedAt
        ? Math.round((Date.now() - call.acceptedAt) / 1000)
        : undefined;
    await logCallMessage(io, {
        callerId: call.callerId,
        calleeId: call.calleeId,
        isAudio: call.isAudio,
        callEvent: accepted ? 'ended' : 'missed',
        duration,
        call,
    });
}

// A call is registered on the server its caller is connected to. Behind a
// load balancer (or with PEER_SERVERS) the other person's answer or hang-up
// can reach a different server, which has no record of the call. That server
// still relays the event to the people in the call (the peer adapter carries
// it) and tells the other servers, so the one holding the record stops its
// ring timer (otherwise it ended every such call a minute in) or closes and
// logs the call.
const CALL_SYNC_EVENT = 'calls:sync';
const syncedServers = new WeakSet();

const publishCallSync = (io, message) => {
    if (!peerServersConfigured()) return;
    try {
        io.serverSideEmit(CALL_SYNC_EVENT, message);
    } catch (err) {
        console.warn('Call sync to peer servers failed:', err?.message || err);
    }
};

async function applyCallSync(io, { type, channelName, by, reason, isAudio } = {}) {
    if (!channelName || !by) return;
    const call = activeCalls.get(String(channelName));
    if (!call) {
        // Answered on another server after the call ended here (cancelled,
        // timed out): close the answering device's call screen.
        if (type === 'answered' && wasFinished(channelName)) {
            io.to(String(by)).emit(`${callTypeOf(isAudio)}-call-cancelled`, {
                to: String(by), channelName: String(channelName), reason: 'ended',
            });
        }
        return;
    }
    if (!isParticipant(call, by)) return;
    if (type === 'answered') {
        if (call.accepted) return;
        call.accepted = true;
        call.acceptedAt = call.acceptedAt || Date.now();
        clearCallTimer(call);
        return;
    }
    if (type === 'finished') {
        await closeCallRecord(io, call, reason);
    }
}

const listenForCallSync = (io) => {
    if (syncedServers.has(io)) return;
    syncedServers.add(io);
    io.on(CALL_SYNC_EVENT, (message) => {
        applyCallSync(io, message).catch((err) => {
            console.error('Applying call sync failed:', err?.message || err);
        });
    });
};

// The callee declines (or auto-declines because they are busy). `socket` is
// the declining device's socket, or null when the decline came over HTTP
// from a push notification's Decline button.
async function rejectCallAs(io, me, { to, channelName, reason } = {}, isAudioHint, socket = null) {
    if (!to) return;
    const call = findCall(channelName, me, to);
    // A duplicate push/socket delivery can make one of the callee's
    // devices send reject after another device answered. Never
    // invalidate an accepted call.
    if (call && call.accepted) return;
    // Late duplicate: the call was already declined, cancelled or timed out
    // and the caller was told.
    if (!call && wasFinished(channelName)) return;
    const isAudio = call ? call.isAudio : isAudioHint;
    const type = callTypeOf(isAudio);
    if (call) removeCall(call.channelName);
    const channel = channelName || call?.channelName;
    const payload = { to, connectId: me, channelName: channel };
    io.to(String(to)).emit(`${type}-call-rejected`, {
        ...payload,
        reason: reason === 'busy' ? 'busy' : 'declined',
    });
    // Stop ringing on the callee's other devices (web tab + phone). A decline
    // from a push has no socket, so every device of the callee is told.
    (socket ? socket.to(me) : io.to(me)).emit(`${type}-call-cancelled`, {
        ...payload, connectId: String(to), reason: 'rejected_elsewhere',
    });
    if (call) {
        await logCallMessage(io, { callerId: call.callerId, calleeId: call.calleeId, isAudio, callEvent: 'missed', call });
    } else if (channel) {
        publishCallSync(io, { type: 'finished', channelName: String(channel), by: me, reason: 'declined' });
    }
}

module.exports = function callingSocket(io, socket, profileId, onlineUsers) {
    const me = String(profileId);
    listenForCallSync(io);

    const startCall = async ({ to, channelName } = {}, isAudio) => {
        const type = callTypeOf(isAudio);
        if (!to || !channelName) {
            console.warn(`${type}-call: Missing to or channelName`, { to, channelName });
            return;
        }
        const calleeId = String(to);
        if (calleeId === me) return;
        pruneStaleCalls();

        // A re-sent start for the same channel replaces the old record.
        removeCall(String(channelName));

        // The person being called is already on another call: tell the caller
        // straight away ("On another call") instead of ringing for a minute,
        // and leave the callee a missed-call entry, like WhatsApp does.
        if (findBusyCall(io, calleeId, channelName)) {
            finishedCalls.set(String(channelName), Date.now());
            socket.emit(`${type}-call-rejected`, {
                to: calleeId, connectId: calleeId, channelName: String(channelName), reason: 'busy',
            });
            await sendMissedCallPush(calleeId, me, !!isAudio, String(channelName));
            await logCallMessage(io, { callerId: me, calleeId, isAudio: !!isAudio, callEvent: 'missed' });
            return;
        }

        // Register the call BEFORE any await. The caller's cancel can arrive
        // while the profile lookup below is pending (instant hang-up); it must
        // find this record, otherwise the callee is rung afterwards and keeps
        // ringing until the timeout.
        const call = {
            channelName: String(channelName),
            callerId: me,
            calleeId,
            callerSocketId: socket.id,
            isAudio: !!isAudio,
            accepted: false,
            answeredSocketId: null,
            createdAt: Date.now(),
            acceptedAt: null,
            timer: null,
            logged: false,
            callerInfo: null,
            calleeInfo: null,
        };
        activeCalls.set(call.channelName, call);
        // Older clients reuse `${caller}-${callee}` as the channel for every
        // call between a pair, so a new call must clear the previous call's
        // marker. (Current clients add a per-call suffix.)
        finishedCalls.delete(call.channelName);
        // Cancelled (or replaced) while we were awaiting.
        const isStillRinging = () => activeCalls.get(call.channelName) === call && !call.accepted;

        // Both profiles are looked up once, here, so answering the call can
        // relay "call-accepted" instantly instead of waiting on the database.
        const [myProfileData, calleeProfileData] = await Promise.all([
            findCallProfile(me).catch(() => null),
            findCallProfile(calleeId).catch(() => null),
        ]);
        call.callerInfo = { fullName: myProfileData?.fullName, profilePic: myProfileData?.profilePic };
        call.calleeInfo = { fullName: calleeProfileData?.fullName, profilePic: calleeProfileData?.profilePic };
        if (!isStillRinging()) return;
        const callerName = myProfileData?.fullName || 'Someone';
        const callerProfilePic = myProfileData?.profilePic || '';

        // No connected device → the callee can only be reached by push.
        // Callee devices that do receive the call reply "Ringing...".
        if (!roomHasSockets(io, calleeId)) {
            socket.emit('updated-call-status', {
                from: calleeId, status: 'Calling...', channelName: call.channelName,
            });
        }

        io.to(calleeId).emit(`incoming-${type}-call`, {
            from: me,
            channelName: call.channelName,
            isAudio: !!isAudio,
            callerName,
            callerProfilePic,
        });

        // Unanswered → missed call. Tell both sides so neither keeps ringing.
        call.timer = setTimeout(async () => {
            const current = activeCalls.get(call.channelName);
            if (current !== call || call.accepted) return;
            removeCall(call.channelName);
            io.to(me).emit('call-not-accepted', { to: calleeId, channelName: call.channelName, isAudio: !!isAudio });
            io.to(calleeId).emit(`${type}-call-cancelled`, {
                to: calleeId, connectId: me, channelName: call.channelName, reason: 'timeout',
            });
            await sendMissedCallPush(calleeId, me, !!isAudio, call.channelName);
            await logCallMessage(io, { callerId: me, calleeId, isAudio: !!isAudio, callEvent: 'missed', call });
        }, RING_TIMEOUT_MS);

        // Visible notification + data (Expo / FCM). Data-only is often silent on iOS.
        try {
            await sendPushToProfile(calleeId, {
                title: isAudio ? 'Incoming audio call' : 'Incoming video call',
                body: `${callerName} is calling`,
                channelId: 'incoming_calls_v3',
                data: {
                    type: 'incoming_call',
                    isAudio: isAudio ? 'true' : 'false',
                    callerId: me,
                    callerName: myProfileData?.fullName || '',
                    callerProfilePic,
                    channelName: call.channelName,
                }
            });
        } catch (e) { }
        // Don't send a web "incoming call" notification for a call that was
        // cancelled while the FCM push was being sent.
        if (!isStillRinging()) return;
        // iOS Home Screen / PWA (no FCM) — wake via Web Push
        try {
            await sendIncomingCallWebPush(calleeId, {
                isAudio: !!isAudio,
                callerId: me,
                callerName,
                callerProfilePic,
                channelName: call.channelName,
            });
        } catch (e) { }
    };

    socket.on('video-call', (data) => startCall(data, false));
    socket.on('audio-call', (data) => startCall(data, true));

    // Caller hangs up before the callee answered.
    const cancelCall = async ({ to, channelName } = {}, isAudioHint) => {
        if (!to) return;
        const call = findCall(channelName, me, to);
        if (call && call.accepted) {
            // Already answered: treat as a normal hang-up.
            return endCall({ to, channelName: call.channelName }, call.isAudio);
        }
        // Late duplicate for a call that already ended; the callee was told.
        if (!call && wasFinished(channelName)) return;
        const isAudio = call ? call.isAudio : isAudioHint;
        const type = callTypeOf(isAudio);
        if (call) removeCall(call.channelName);
        const channel = channelName || call?.channelName;
        io.to(String(to)).emit(`${type}-call-cancelled`, {
            to, connectId: me, channelName: channel,
        });
        if (!call) {
            if (channel) publishCallSync(io, { type: 'finished', channelName: String(channel), by: me, reason: 'cancelled' });
            return;
        }
        if (call.callerId === me) {
            await sendMissedCallPush(call.calleeId, me, isAudio, call.channelName);
            await logCallMessage(io, { callerId: me, calleeId: call.calleeId, isAudio, callEvent: 'missed', call });
        }
    };
    socket.on('video-call-cancel', (data) => cancelCall(data, false));
    socket.on('audio-call-cancel', (data) => cancelCall(data, true));

    const rejectCall = (data, isAudioHint) => rejectCallAs(io, me, data, isAudioHint, socket);
    socket.on('video-call-reject', (data) => rejectCall(data, false));
    socket.on('audio-call-reject', (data) => rejectCall(data, true));

    // Either participant hangs up.
    const endCall = async ({ to, channelName } = {}, isAudioHint) => {
        if (!to) return;
        const connectId = String(to);
        const call = findCall(channelName, me, connectId);
        // Late duplicate for a call that was already cancelled/ended/timed out
        // (both apps send an end when they see the other side leave).
        if (!call && wasFinished(channelName)) return;
        const isAudio = call ? call.isAudio : isAudioHint;
        const type = callTypeOf(isAudio);
        const accepted = !!call?.accepted;
        if (call) removeCall(call.channelName);
        const channel = channelName || call?.channelName;

        io.to(connectId).emit(`${type}-call-ended`, {
            from: me,
            channelName: channel,
        });
        if (!call) {
            // This server has no record of the call: another server holds it
            // (it closes and logs the call), or this one restarted mid-call.
            // Who called whom is unknown here, so no missed-call push or log.
            if (channel) publishCallSync(io, { type: 'finished', channelName: String(channel), by: me, reason: 'ended' });
            return;
        }

        if (!accepted) {
            // Stop the callee ringing on every device and tell them they missed it.
            if (call.callerId === me) {
                io.to(call.calleeId).emit(`${type}-call-cancelled`, {
                    to: call.calleeId, connectId: me, channelName: call.channelName,
                });
            }
            await sendMissedCallPush(call.calleeId, call.callerId, isAudio, call.channelName);
        }
        const duration = accepted && call.acceptedAt
            ? Math.round((Date.now() - call.acceptedAt) / 1000)
            : undefined;
        await logCallMessage(io, {
            callerId: call.callerId, calleeId: call.calleeId, isAudio, callEvent: accepted ? 'ended' : 'missed', duration, call,
        });
    };
    socket.on('video-call-end', (data) => endCall(data, false));
    socket.on('audio-call-end', (data) => endCall(data, true));

    socket.on('answer-call', async ({ to, channelName, isAudio: isAudioHint = false } = {}) => {
        try {
            if (!to) return;
            const callerId = String(to);
            const call = findCall(channelName, callerId, me);
            const isAudio = call ? call.isAudio : !!isAudioHint;
            const type = callTypeOf(isAudio);
            const channel = channelName || call?.channelName;

            if (!call && wasFinished(channel)) {
                // The caller hung up (or the call timed out / was declined on
                // another device) before this answer arrived. Close this
                // device's call screen instead of leaving it in an empty call.
                socket.emit(`${type}-call-cancelled`, {
                    to: me, connectId: callerId, channelName: channel, reason: 'ended',
                });
                return;
            }

            if (call) {
                const answeredElsewhere =
                    call.accepted &&
                    call.answeredSocketId &&
                    call.answeredSocketId !== socket.id &&
                    io.sockets.sockets.has(call.answeredSocketId);
                if (answeredElsewhere) {
                    // Another of my devices already answered — close this one.
                    socket.emit(`${type}-call-cancelled`, {
                        to: me, connectId: callerId, channelName: channel, reason: 'answered_elsewhere',
                    });
                    return;
                }
                call.accepted = true;
                call.answeredSocketId = socket.id;
                call.acceptedAt = call.acceptedAt || Date.now();
                clearCallTimer(call);
            } else if (channel) {
                publishCallSync(io, { type: 'answered', channelName: String(channel), by: me, isAudio });
            }

            // Profiles cached when the call started; look them up only when
            // the call record (or its lookup) is missing, e.g. the server
            // restarted mid-ring or the callee answered instantly.
            const [calleeProfileData, callerProfileData] = call?.calleeInfo && call?.callerInfo
                ? [call.calleeInfo, call.callerInfo]
                : await Promise.all([
                    findCallProfile(me).catch(() => null),
                    findCallProfile(callerId).catch(() => null),
                ]);

            // Every device of the caller hears it: the socket that placed the
            // call may have reconnected (new id), and its old id can look
            // connected until the server notices it is gone. Clients only join
            // when the channel is the call they are placing, so idle devices
            // (e.g. a web tab while calling from the phone) stay out.
            io.to(callerId).emit('call-accepted', {
                channelName: channel,
                isAudio,
                callerName: calleeProfileData?.fullName,
                callerProfilePic: calleeProfileData?.profilePic,
                callerId: me,
            });

            // Echo to the answering device so it can open the call UI with caller info
            socket.emit('call-accepted', {
                channelName: channel,
                isAudio,
                callerName: callerProfileData?.fullName,
                callerProfilePic: callerProfileData?.profilePic,
                callerId,
            });

            // Stop ringing on my other devices.
            socket.to(me).emit(`${type}-call-cancelled`, {
                to: me, connectId: callerId, channelName: channel, reason: 'answered_elsewhere',
            });
        } catch (err) {
            console.error('Error handling answer-call:', err, { to, channelName });
        }
    });

    const relayCallStatus = async ({ to, status, channelName } = {}) => {
        if (!to) return;
        io.to(String(to)).emit('updated-call-status', {
            from: me,
            status: status || '',
            ...(channelName ? { channelName: String(channelName) } : {}),
        });
    };
    // Clients emit `update-call-status`; keep legacy alias too
    socket.on('update-call-status', relayCallStatus);
    socket.on('call-status-update', relayCallStatus);

    // The caller's device went away (tab closed, app killed, network lost)
    // while the call was still ringing. Give it a moment to reconnect, then
    // stop the callee ringing on every device and leave a missed call.
    socket.on('disconnect', () => {
        for (const call of activeCalls.values()) {
            if (call.accepted || call.callerSocketId !== socket.id) continue;
            const channelName = call.channelName;
            setTimeout(async () => {
                const current = activeCalls.get(channelName);
                if (current !== call || call.accepted) return;
                if (roomHasSockets(io, call.callerId)) return;
                removeCall(channelName);
                const type = callTypeOf(call.isAudio);
                io.to(call.calleeId).emit(`${type}-call-cancelled`, {
                    to: call.calleeId, connectId: call.callerId, channelName, reason: 'caller_disconnected',
                });
                await sendMissedCallPush(call.calleeId, call.callerId, call.isAudio, channelName);
                await logCallMessage(io, {
                    callerId: call.callerId, calleeId: call.calleeId, isAudio: call.isAudio, callEvent: 'missed', call,
                });
            }, CALLER_DISCONNECT_GRACE_MS);
        }
    });

    // Captions are opt-in and scoped to the active call channel. Never relay
    // arbitrary text or audio; the authenticated socket identity is the sender.
    // Registered once per socket (it used to be re-registered on every answer).
    socket.on('call-transcript', ({ to, channelName, text, isFinal = false } = {}) => {
        const target = String(to || '');
        const channel = String(channelName || '');
        const transcript = String(text || '').trim().slice(0, 500);
        if (!target || !channel || !transcript) return;
        io.to(target).emit('call-transcript', {
            senderId: me,
            channelName: channel,
            text: transcript,
            isFinal: Boolean(isFinal),
        });
    });
};

// Decline pressed on an incoming-call push (app in the background, often no
// socket): same as the socket `*-call-reject`, so the call record is closed,
// the callee's other devices stop ringing and the missed call is logged.
module.exports.rejectCallFromPush = (io, calleeId, { callerId, channelName }, isAudio) =>
    rejectCallAs(io, String(calleeId), { to: String(callerId), channelName }, !!isAudio, null);

// Exposed for tests.
module.exports.applyCallSync = applyCallSync;
