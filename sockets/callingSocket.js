const { isValidObjectId } = require('mongoose');
const Message = require('../models/Message')
const Profile = require('../models/Profile')
const checkIsActive = require('../utils/checkIsActive')
const axios = require('axios')
const { sendPushToProfile, sendDataPushToProfile } = require('../utils/pushNotifications')
const { sendWebPushToProfile } = require('../utils/webPush')
const { getIncomingCallAlertForProfile } = require('../utils/ringtone')
const config = require('../config/config.json');

const sendEmailNotification = require('../utils/sendEmailNotification')

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

module.exports = function callingSocket(io, socket, profileId, onlineUsers) {


    // Agora calling socket
    const MISSED_CALL_TIMEOUT_MS = 300000;
    const callTimeouts = new Map(); // key -> { timer, to, from, isAudio, transport, channelName }
    // Track acceptance state and recently-created call messages to avoid duplicates
    const callStateByRoom = new Map(); // roomKey -> { accepted?: boolean, recentEvents?: Map<string, number> }

    const getRoomKey = (a, b) => [String(a), String(b)].sort().join('_');
    const markAccepted = (roomKey) => {
        const state = callStateByRoom.get(roomKey) || {};
        state.accepted = true;
        callStateByRoom.set(roomKey, state);
    };
    const wasAccepted = (roomKey) => !!(callStateByRoom.get(roomKey)?.accepted);
    const recordEventOnce = (roomKey, callType, event, ttlMs = 10000) => {
        const state = callStateByRoom.get(roomKey) || {};
        const now = Date.now();
        const key = `${callType}:${event}`;
        if (!state.recentEvents) state.recentEvents = new Map();
        const last = state.recentEvents.get(key) || 0;
        if (now - last < ttlMs) return false; // recently created
        state.recentEvents.set(key, now);
        callStateByRoom.set(roomKey, state);
        return true;
    };

    const broadcastCallMessage = async ({ updatedMessage, senderId, otherId, senderProfile }) => {
        const room = getRoomKey(senderId, otherId);
        const senderName = (senderProfile?.user?.firstName || '') + ' ' + (senderProfile?.user?.surname || '');
        const senderPP = senderProfile?.profilePic || config?.defaultProfile;
        const roomPayload = { updatedMessage, senderName, senderPP, chatPage: true };
        const userPayload = { updatedMessage, senderName, senderPP, chatPage: false, connectProfile: senderProfile };
        io.to(room).emit('newMessage', roomPayload);
        io.to(String(otherId)).emit('newMessage', roomPayload);
        io.to(String(senderId)).emit('newMessage', roomPayload);
        io.to(String(otherId)).emit('newMessageToUser', userPayload);
        io.to(String(senderId)).emit('newMessageToUser', userPayload);
    };

    socket.on("video-call", async ({ to, channelName, isAudio = false }) => {
        if (!to || !channelName) {
            console.warn('video-call: Missing to or channelName', { to, channelName });
            return;
        }
        let myProfileData = await Profile.findById(profileId)
        io.to(String(to)).emit("incoming-video-call", { from: String(profileId), channelName, isAudio: false, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
        // Visible notification + data (Expo / FCM). Data-only is often silent on iOS.
        try {
            const callerName = myProfileData.fullName || 'Someone';
            await sendPushToProfile(to, {
                title: 'Incoming video call',
                body: `${callerName} is calling`,
                channelId: 'incoming_calls_v3',
                data: {
                    type: 'incoming_call',
                    isAudio: 'false',
                    callerId: String(profileId),
                    callerName: myProfileData.fullName || '',
                    callerProfilePic: myProfileData.profilePic || '',
                    channelName: channelName || ''
                }
            });
            // iOS Home Screen / PWA (no FCM) — wake via Web Push
            await sendIncomingCallWebPush(to, {
                isAudio: false,
                callerId: profileId,
                callerName,
                callerProfilePic: myProfileData.profilePic || '',
                channelName,
            });
        } catch (e) { }

        // Schedule missed-call push if not accepted within timeout
        try {
            const key = `agora:${channelName}`;
            if (callTimeouts.has(key)) {
                clearTimeout(callTimeouts.get(key).timer);
                callTimeouts.delete(key);
            }
            const timer = setTimeout(async () => {
                try {
                    await sendPushToProfile(to, {
                        title: 'Missed video call',
                        body: 'You missed a video call',
                        data: { type: 'missed_call', isVideo: 'true' }
                    });
                    await sendWebPushToProfile(to, {
                        title: 'Missed video call',
                        body: 'You missed a video call',
                        type: 'missed_call',
                        tag: `missed-call-${channelName || Date.now()}`,
                        link: `/message/${profileId}`,
                        data: { type: 'missed_call', isVideo: 'true', url: `/message/${profileId}` },
                    });
                } catch (err) { }
                callTimeouts.delete(key);
                // Notify caller so UI can close/mark as missed
                io.to(String(profileId)).emit('call-not-accepted', { to: String(to), channelName, isAudio: false });
            }, MISSED_CALL_TIMEOUT_MS);
            callTimeouts.set(key, { timer, to, from: profileId, isAudio: false, transport: 'agora', channelName });
        } catch (err) { }
    });

    socket.on("video-call-cancel", async ({ to, channelName }) => {
        if (!to || !channelName) {
            console.warn('video-call-cancel: Missing to or channelName', { to, channelName });
            return;
        }
        callTimeouts.delete(`agora:${channelName}`);
        io.to(String(to)).emit('video-call-cancelled', { to, connectId: profileId, channelName });
    });

    socket.on("video-call-reject", async ({ to, channelName }) => {
        if (!to || !channelName) {
            console.warn('video-call-reject: Missing to or channelName', { to, channelName });
            return;
        }
        callTimeouts.delete(`agora:${channelName}`);
        io.to(String(to)).emit('video-call-rejected', { to, connectId: profileId, channelName });
    });

    socket.on("video-call-end", async ({ to, channelName }) => {
        callTimeouts.delete(`agora:${channelName}`);

        let connectId = to;

        try {

            // Emit to the connect's profile room (all tabs), not a single socket id
            if (connectId) {
                io.to(String(connectId)).emit('video-call-ended', {
                    from: String(profileId),
                    channelName,
                });
            }
            try {
                for (const [key, entry] of callTimeouts.entries()) {
                    if (entry && entry.transport === 'agora' && entry.to === connectId && entry.from === profileId) {
                        clearTimeout(entry.timer);
                        callTimeouts.delete(key);
                    }
                }
            } catch (e) { }
            const roomKey = getRoomKey(profileId, connectId);
            const accepted = wasAccepted(roomKey);
            // Only send push for missed
            if (!accepted) {
                try {
                    await sendPushToProfile(connectId, {
                        title: 'Missed video call',
                        body: 'You missed a video call',
                        data: { type: 'missed_call', isVideo: 'true' }
                    });
                } catch (e) { }
            }

            // Create and emit a call message to both participants
            try {
                const room = roomKey;
                const callEvent = accepted ? 'ended' : 'missed';
                if (recordEventOnce(roomKey, 'video', callEvent)) {
                    const callMsg = new Message({
                        room,
                        senderId: String(profileId),
                        receiverId: String(connectId),
                        message: callEvent === 'missed' ? 'Missed video call' : 'Video call ended',
                        messageType: 'call',
                        callType: 'video',
                        callEvent
                    });
                    await callMsg.save();
                    const updatedMessage = await Message.findOne({ _id: callMsg._id }).populate('parent');
                    const profileData = await Profile.findById(profileId).populate('user');
                    if (profileData) {
                        await broadcastCallMessage({
                            updatedMessage,
                            senderId: String(profileId),
                            otherId: String(connectId),
                            senderProfile: profileData,
                        });
                    }
                }
            } catch (e) {
            }
        } catch (err) {
            console.error('Error handling leaveVideoCall:', err, connectId);
        }
    });

    socket.on("audio-call", async ({ to, channelName, isAudio = true }) => {
        if (!to || !channelName) {
            console.warn('audio-call: Missing to or channelName', { to, channelName });
            return;
        }
        let myProfileData = await Profile.findById(profileId)
        io.to(String(to)).emit("incoming-audio-call", { from: String(profileId), channelName, isAudio: true, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
        try {
            const callerName = myProfileData.fullName || 'Someone';
            await sendPushToProfile(to, {
                title: 'Incoming audio call',
                body: `${callerName} is calling`,
                channelId: 'incoming_calls_v3',
                data: {
                    type: 'incoming_call',
                    isAudio: 'true',
                    callerId: String(profileId),
                    callerName: myProfileData.fullName || '',
                    callerProfilePic: myProfileData.profilePic || '',
                    channelName: channelName || ''
                }
            });
            // iOS Home Screen / PWA (no FCM) — wake via Web Push
            await sendIncomingCallWebPush(to, {
                isAudio: true,
                callerId: profileId,
                callerName,
                callerProfilePic: myProfileData.profilePic || '',
                channelName,
            });
        } catch (e) { }

        // Schedule missed-call push if not accepted within timeout
        try {
            const key = `agora:${channelName}`;
            if (callTimeouts.has(key)) {
                clearTimeout(callTimeouts.get(key).timer);
                callTimeouts.delete(key);
            }
            const timer = setTimeout(async () => {
                try {
                    await sendPushToProfile(to, {
                        title: 'Missed audio call',
                        body: 'You missed an audio call',
                        data: { type: 'missed_call', isVideo: 'false' }
                    });
                    await sendWebPushToProfile(to, {
                        title: 'Missed audio call',
                        body: 'You missed an audio call',
                        type: 'missed_call',
                        tag: `missed-call-${channelName || Date.now()}`,
                        link: `/message/${profileId}`,
                        data: { type: 'missed_call', isVideo: 'false', url: `/message/${profileId}` },
                    });
                } catch (err) { }
                callTimeouts.delete(key);
                io.to(profileId).emit('call-not-accepted', { to, channelName, isAudio: true });
            }, MISSED_CALL_TIMEOUT_MS);
            callTimeouts.set(key, { timer, to, from: profileId, isAudio: true, transport: 'agora', channelName });
        } catch (err) { }
    });

    const relayCallStatus = async ({ to, status }) => {
        if (!to) return;
        io.to(String(to)).emit('updated-call-status', {
            from: String(profileId),
            status: status || '',
        });
    };
    // Clients emit `update-call-status`; keep legacy alias too
    socket.on("update-call-status", relayCallStatus);
    socket.on("call-status-update", relayCallStatus);

    socket.on("audio-call-cancel", async ({ to, channelName }) => {
        if (!to || !channelName) {
            console.warn('audio-call-cancel: Missing to or channelName', { to, channelName });
            return;
        }
        callTimeouts.delete(`agora:${channelName}`);
        io.to(String(to)).emit('audio-call-cancelled', { to, connectId: profileId, channelName });
    });

    socket.on("audio-call-reject", async ({ to, channelName }) => {
        if (!to || !channelName) {
            console.warn('audio-call-reject: Missing to or channelName', { to, channelName });
            return;
        }
        // A duplicate push/socket delivery can cause a callee to send reject
        // after answering. Do not invalidate an already accepted call.
        const roomKey = getRoomKey(profileId, to);
        if (wasAccepted(roomKey)) {
            return;
        }
        callTimeouts.delete(`agora:${channelName}`);
        io.to(String(to)).emit('audio-call-rejected', { to, connectId: profileId, channelName });
    });

    // End audio call
    socket.on('audio-call-end', async ({to: connectId, channelName}) => {
        try {

            // Emit to the connect's profile room (all tabs)
            if (connectId) {
                io.to(String(connectId)).emit('audio-call-ended', {
                    from: String(profileId),
                    channelName,
                });
            }

            // Clear any pending missed-call timers for this caller<->connect pair
            try {
                for (const [key, entry] of callTimeouts.entries()) {
                    if (entry && entry.transport === 'agora' && entry.to === connectId && entry.from === profileId) {
                        clearTimeout(entry.timer);
                        callTimeouts.delete(key);
                    }
                }
            } catch (e) { }
            const roomKey = getRoomKey(profileId, connectId);
            const accepted = wasAccepted(roomKey);
            if (!accepted) {
                try {
                    await sendPushToProfile(connectId, {
                        title: 'Missed audio call',
                        body: 'You missed an audio call',
                        data: { type: 'missed_call', isVideo: 'false' }
                    });
                } catch (e) { }
            }

            // Create and emit a call message to both participants
            try {
                const room = roomKey;
                const callEvent = accepted ? 'ended' : 'missed';
                if (recordEventOnce(roomKey, 'audio', callEvent)) {
                    const callMsg = new Message({
                        room,
                        senderId: String(profileId),
                        receiverId: String(connectId),
                        message: callEvent === 'missed' ? 'Missed audio call' : 'Audio call ended',
                        messageType: 'call',
                        callType: 'audio',
                        callEvent
                    });
                    await callMsg.save();
                    const updatedMessage = await Message.findOne({ _id: callMsg._id }).populate('parent');
                    const profileData = await Profile.findById(profileId).populate('user');
                    if (profileData) {
                        await broadcastCallMessage({
                            updatedMessage,
                            senderId: String(profileId),
                            otherId: String(connectId),
                            senderProfile: profileData,
                        });
                    }
                }
            } catch (e) {
            }
        } catch (err) {
            console.error('Error handling leaveAudioCall:', err, connectId);
        }
    });


    socket.on("answer-call", async ({ to, channelName, isAudio = false }) => {
        try {
            // Record acceptance before async work so a duplicate reject cannot
            // invalidate a call while profile data/events are being prepared.
            const roomKey = getRoomKey(profileId, to);
            markAccepted(roomKey);

            // Clear any pending missed-call timer for this channel
            try {
                const key = `agora:${channelName}`;
                const entry = callTimeouts.get(key);
                if (entry) {
                    clearTimeout(entry.timer);
                    callTimeouts.delete(key);
                }
            } catch (e) { }
            
            // callee = current socket's profileId (person who accepted the call)
            const calleeProfileData = await Profile.findById(profileId);
            // caller = the 'to' user (person who initiated the call)
            const callerProfileData = await Profile.findById(to);

            // Notify the caller that the callee accepted (show callee info on caller's phone)
            io.to(String(to)).emit("call-accepted", {
                channelName,
                isAudio,
                callerName: calleeProfileData?.fullName,
                callerProfilePic: calleeProfileData?.profilePic,
                callerId: String(profileId)
            });

            // Also notify the callee (echo) so their app can open the call UI with caller info
            socket.emit("call-accepted", {
                channelName,
                isAudio,
                callerName: callerProfileData?.fullName,
                callerProfilePic: callerProfileData?.profilePic,
                callerId: String(to)
            });

            // Captions are opt-in and scoped to the active call channel. Never relay
            // arbitrary text or audio; the authenticated socket identity is the sender.
            socket.on("call-transcript", ({ to, channelName, text, isFinal = false } = {}) => {
                const target = String(to || '');
                const channel = String(channelName || '');
                const transcript = String(text || '').trim().slice(0, 500);
                if (!target || !channel || !transcript) return;
                io.to(target).emit('call-transcript', {
                    senderId: String(profileId),
                    channelName: channel,
                    text: transcript,
                    isFinal: Boolean(isFinal),
                });
            });

            // Mark this room as accepted to avoid sending 'missed' on leave
        } catch (err) {
            console.error('Error handling agora-answer-call:', err, { to, channelName, isAudio });
        }
    });
    //         console.log(`📞 call-user from ${data.from} -> ${data.userToCall}`);
    //         const targetSocketId = onlineUsers.get(data.userToCall);
    //         if (targetSocketId) {
    //             io.to(targetSocketId).emit('receive-call', {
    //                 signal: data.signalData, // MUST be the raw simple-peer signal object
    //                 from: data.from,
    //                 name: data.name,
    //                 isVideo: data.isVideo
    //             });
    //         } else {
    //             console.log('Target not online for call:', data.userToCall);
    //         }
    //         // Schedule missed-call push if not accepted within timeout
    //         try {
    //             const key = `peer:${data.from}:${data.userToCall}`;
    //             if (callTimeouts.has(key)) {
    //                 clearTimeout(callTimeouts.get(key).timer);
    //                 callTimeouts.delete(key);
    //             }
    //             const timer = setTimeout(async () => {
    //                 const title = data.isVideo ? 'Missed video call' : 'Missed audio call';
    //                 const body = data.isVideo ? 'You missed a video call' : 'You missed an audio call';
    //                 try {
    //                     await sendPushToProfile(data.userToCall, {
    //                         title,
    //                         body,
    //                         data: { type: 'missed_call', isVideo: data.isVideo ? 'true' : 'false' }
    //                     });
    //                 } catch (err) {}
    //                 callTimeouts.delete(key);
    //                 io.to(data.from).emit('call-not-accepted', { to: data.userToCall, isVideo: data.isVideo });
    //             }, MISSED_CALL_TIMEOUT_MS);
    //             callTimeouts.set(key, { timer, to: data.userToCall, from: data.from, isAudio: !data.isVideo, transport: 'peer' });
    //         } catch (err) {}
    //     } catch (err) {
    //         console.error('Error handling call-user:', err, data);
    //     }
    // });

    // // Callee answers - expect: { signal: <simple-peer-signal>, to: <callerProfileId>, from: <calleeProfileId> }
    // socket.on('answer-call', (data) => {

    //     console.log('answer-call', data)
    //     try {
    //         console.log(`✅ answer-call from ${data.from} -> ${data.to}`);
    //         // Clear any pending missed-call timer for this peer call
    //         try {
    //             const key = `peer:${data.to}:${data.from}`; // (caller:calle)
    //             const entry = callTimeouts.get(key);
    //             if (entry) {
    //                 clearTimeout(entry.timer);
    //                 callTimeouts.delete(key);
    //             }
    //         } catch (e) {}
    //         const targetSocketId = onlineUsers.get(data.to);
    //         if (targetSocketId) {
    //             io.to(targetSocketId).emit('call-accepted', {
    //                 signal: data.signal, // raw signal from callee
    //                 from: data.from
    //             });
    //         } else {
    //             console.log('Caller not online to receive answer:', data.to);
    //         }
    //     } catch (err) {
    //         console.error('Error handling answer-call:', err, data);
    //     }
    // });





};
