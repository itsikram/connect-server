const Message = require('../models/Message')
const Profile = require('../models/Profile')
const { sendPushToProfile } = require('../utils/pushNotifications')
const { sendWebPushToProfile } = require('../utils/webPush')
const { getIncomingCallAlertForProfile } = require('../utils/ringtone')
const config = require('../config/config.json');

// How long an unanswered call rings before it becomes a missed call.
const RING_TIMEOUT_MS = 60000;
// Accepted calls whose end event never arrived (app killed, network lost) are
// dropped after this long so the registry cannot grow without bound.
const STALE_CALL_MS = 6 * 60 * 60 * 1000;

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

// Resolve the call a client event refers to. Clients normally send the
// channelName; fall back to the most recent call between the pair.
const wasFinished = (channelName) => !!channelName && finishedCalls.has(String(channelName));

const findCall = (channelName, a, b) => {
    if (channelName && activeCalls.has(String(channelName))) {
        return activeCalls.get(String(channelName));
    }
    if (!a || !b) return null;
    let latest = null;
    for (const call of activeCalls.values()) {
        const samePair =
            (call.callerId === String(a) && call.calleeId === String(b)) ||
            (call.callerId === String(b) && call.calleeId === String(a));
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
        callerName = (await Profile.findById(callerId).select('fullName'))?.fullName || '';
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
        const callMsg = new Message({
            room,
            senderId: String(callerId),
            receiverId: String(calleeId),
            message,
            messageType: 'call',
            callType,
            callEvent,
            ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
        });
        await callMsg.save();
        const updatedMessage = await Message.findOne({ _id: callMsg._id }).populate('parent');
        const senderProfile = await Profile.findById(callerId).populate('user');
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

module.exports = function callingSocket(io, socket, profileId, onlineUsers) {
    const me = String(profileId);

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

        let myProfileData = null;
        try {
            myProfileData = await Profile.findById(me).select('fullName profilePic');
        } catch (e) { }
        const callerName = myProfileData?.fullName || 'Someone';
        const callerProfilePic = myProfileData?.profilePic || '';

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
        };
        activeCalls.set(call.channelName, call);
        // Clients reuse `${caller}-${callee}` as the channel for every call
        // between a pair, so a new call must clear the previous call's marker.
        finishedCalls.delete(call.channelName);

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
        const isAudio = call ? call.isAudio : isAudioHint;
        const type = callTypeOf(isAudio);
        if (call && call.accepted) {
            // Already answered: treat as a normal hang-up.
            return endCall({ to, channelName: call.channelName }, isAudio);
        }
        if (call) removeCall(call.channelName);
        io.to(String(to)).emit(`${type}-call-cancelled`, {
            to, connectId: me, channelName: channelName || call?.channelName,
        });
        if (!call && wasFinished(channelName)) return;
        if (call && call.callerId === me) {
            await sendMissedCallPush(call.calleeId, me, isAudio, call.channelName);
            await logCallMessage(io, { callerId: me, calleeId: call.calleeId, isAudio, callEvent: 'missed', call });
        }
    };
    socket.on('video-call-cancel', (data) => cancelCall(data, false));
    socket.on('audio-call-cancel', (data) => cancelCall(data, true));

    // Callee declines (or auto-declines because they are busy).
    const rejectCall = async ({ to, channelName } = {}, isAudioHint) => {
        if (!to) return;
        const call = findCall(channelName, me, to);
        // A duplicate push/socket delivery can make one of the callee's
        // devices send reject after another device answered. Never
        // invalidate an accepted call.
        if (call && call.accepted) return;
        const isAudio = call ? call.isAudio : isAudioHint;
        const type = callTypeOf(isAudio);
        if (call) removeCall(call.channelName);
        const payload = { to, connectId: me, channelName: channelName || call?.channelName };
        io.to(String(to)).emit(`${type}-call-rejected`, payload);
        // Stop ringing on the callee's other devices (web tab + phone).
        socket.to(me).emit(`${type}-call-cancelled`, { ...payload, connectId: String(to), reason: 'rejected_elsewhere' });
        if (call) {
            await logCallMessage(io, { callerId: call.callerId, calleeId: call.calleeId, isAudio, callEvent: 'missed', call });
        }
    };
    socket.on('video-call-reject', (data) => rejectCall(data, false));
    socket.on('audio-call-reject', (data) => rejectCall(data, true));

    // Either participant hangs up.
    const endCall = async ({ to, channelName } = {}, isAudioHint) => {
        if (!to) return;
        const connectId = String(to);
        const call = findCall(channelName, me, connectId);
        const isAudio = call ? call.isAudio : isAudioHint;
        const type = callTypeOf(isAudio);
        const accepted = !!call?.accepted;
        if (call) removeCall(call.channelName);

        io.to(connectId).emit(`${type}-call-ended`, {
            from: me,
            channelName: channelName || call?.channelName,
        });
        // Late duplicate for a call that was already cancelled/ended/timed out.
        if (!call && wasFinished(channelName)) return;

        const callerId = call ? call.callerId : me;
        const calleeId = call ? call.calleeId : connectId;
        if (!accepted) {
            // Stop the callee ringing on every device and tell them they missed it.
            if (callerId === me) {
                io.to(calleeId).emit(`${type}-call-cancelled`, {
                    to: calleeId, connectId: me, channelName: channelName || call?.channelName,
                });
            }
            await sendMissedCallPush(calleeId, callerId, isAudio, channelName || call?.channelName);
        }
        const duration = accepted && call?.acceptedAt
            ? Math.round((Date.now() - call.acceptedAt) / 1000)
            : undefined;
        await logCallMessage(io, {
            callerId, calleeId, isAudio, callEvent: accepted ? 'ended' : 'missed', duration, call,
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

            if (call) {
                if (call.accepted && call.answeredSocketId && call.answeredSocketId !== socket.id) {
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
            }

            const [calleeProfileData, callerProfileData] = await Promise.all([
                Profile.findById(me).select('fullName profilePic').catch(() => null),
                Profile.findById(callerId).select('fullName profilePic').catch(() => null),
            ]);

            // Only the device that placed the call should join. Other idle
            // devices of the caller (e.g. a web tab while calling from the
            // phone) must not auto-join the channel.
            const callerSocketConnected = call?.callerSocketId && io.sockets.sockets.has(call.callerSocketId);
            const callerTarget = callerSocketConnected ? call.callerSocketId : callerId;
            io.to(callerTarget).emit('call-accepted', {
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
