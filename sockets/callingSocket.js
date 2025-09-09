const { isValidObjectId } = require('mongoose');
const Message = require('../models/Message')
const Profile = require('../models/Profile')
const checkIsActive = require('../utils/checkIsActive')
const axios = require('axios')
const { sendPushToProfile, sendDataPushToProfile } = require('../utils/pushNotifications')


const sendEmailNotification = require('../utils/sendEmailNotification')

module.exports = function callingSocket(io, socket, profileId, onlineUsers) {


    // Agora calling socket
    const MISSED_CALL_TIMEOUT_MS = 30000;
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

    socket.on("agora-video-call", async ({ to, channelName, isAudio = false }) => {
        console.log('agora-call-user', { to, channelName })
        let myProfileData = await Profile.findById(profileId)
        io.to(to).emit("agora-incoming-video-call", { from: profileId, channelName, isAudio: false, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
        // Data-only push so app can render custom Notifee incoming call UI
        try {
            await sendDataPushToProfile(to, {
                type: 'incoming_call',
                isAudio: 'false',
                from: String(profileId),
                callerName: myProfileData.fullName || '',
                callerProfilePic: myProfileData.profilePic || '',
                channelName: channelName || ''
            });
        } catch (e) {}

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
                } catch (err) {}
                callTimeouts.delete(key);
                // Notify caller so UI can close/mark as missed
                io.to(profileId).emit('agora-call-not-accepted', { to, channelName, isAudio: false });
            }, MISSED_CALL_TIMEOUT_MS);
            callTimeouts.set(key, { timer, to, from: profileId, isAudio: false, transport: 'agora', channelName });
        } catch (err) {}
    });

    socket.on("agora-audio-call", async ({ to, channelName, isAudio = true }) => {
        console.log('agora-incoming-audio-call', { to, channelName })
        let myProfileData = await Profile.findById(profileId)
        io.to(to).emit("agora-incoming-audio-call", { from: profileId, channelName, isAudio: true, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
        // Data-only push so app can render custom Notifee incoming call UI
        try {
            await sendDataPushToProfile(to, {
                type: 'incoming_call',
                isAudio: 'true',
                from: String(profileId),
                callerName: myProfileData.fullName || '',
                callerProfilePic: myProfileData.profilePic || '',
                channelName: channelName || ''
            });
        } catch (e) {}

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
                } catch (err) {}
                callTimeouts.delete(key);
                io.to(profileId).emit('agora-call-not-accepted', { to, channelName, isAudio: true });
            }, MISSED_CALL_TIMEOUT_MS);
            callTimeouts.set(key, { timer, to, from: profileId, isAudio: true, transport: 'agora', channelName });
        } catch (err) {}
    });


    socket.on("agora-answer-call", async ({ to, channelName, isAudio = false }) => {
        try {
            // Clear any pending missed-call timer for this channel
            try {
                const key = `agora:${channelName}`;
                const entry = callTimeouts.get(key);
                if (entry) {
                    clearTimeout(entry.timer);
                    callTimeouts.delete(key);
                }
            } catch (e) {}
            // callee = current socket's profileId
            const calleeProfileData = await Profile.findById(profileId);
            // caller = the 'to' user
            const callerProfileData = await Profile.findById(to);

            // Notify the caller that the callee accepted (show callee info on caller's phone)
            io.to(to).emit("agora-call-accepted", {
                channelName,
                isAudio,
                callerName: calleeProfileData?.fullName,
                callerProfilePic: calleeProfileData?.profilePic,
                callerId: profileId
            });

            // Also notify the callee (echo) so their app can open the call UI with caller info
            socket.emit("agora-call-accepted", {
                channelName,
                isAudio,
                callerName: callerProfileData?.fullName,
                callerProfilePic: callerProfileData?.profilePic,
                callerId: to
            });

            // Mark this room as accepted to avoid sending 'missed' on leave
            try {
                const roomKey = getRoomKey(profileId, to);
                markAccepted(roomKey);
            } catch (e) {}
        } catch (err) {
            console.error('Error handling agora-answer-call:', err, { to, channelName, isAudio });
        }
    });

    socket.on("agora-filter-video", ({ to, filter }) => {
        io.to(to).emit("agora-apply-video-filter", { filter });
    });

    // Simple-peer calling socket
    // Caller initiates call
    // Expect "data" to contain: { signalData: <simple-peer-signal-object>, from, userToCall, name, isVideo }
    socket.on('call-user', (data) => {
        try {
            console.log(`📞 call-user from ${data.from} -> ${data.userToCall}`);
            const targetSocketId = onlineUsers.get(data.userToCall);
            if (targetSocketId) {
                io.to(targetSocketId).emit('receive-call', {
                    signal: data.signalData, // MUST be the raw simple-peer signal object
                    from: data.from,
                    name: data.name,
                    isVideo: data.isVideo
                });
            } else {
                console.log('Target not online for call:', data.userToCall);
            }
            // Schedule missed-call push if not accepted within timeout
            try {
                const key = `peer:${data.from}:${data.userToCall}`;
                if (callTimeouts.has(key)) {
                    clearTimeout(callTimeouts.get(key).timer);
                    callTimeouts.delete(key);
                }
                const timer = setTimeout(async () => {
                    const title = data.isVideo ? 'Missed video call' : 'Missed audio call';
                    const body = data.isVideo ? 'You missed a video call' : 'You missed an audio call';
                    try {
                        await sendPushToProfile(data.userToCall, {
                            title,
                            body,
                            data: { type: 'missed_call', isVideo: data.isVideo ? 'true' : 'false' }
                        });
                    } catch (err) {}
                    callTimeouts.delete(key);
                    io.to(data.from).emit('call-not-accepted', { to: data.userToCall, isVideo: data.isVideo });
                }, MISSED_CALL_TIMEOUT_MS);
                callTimeouts.set(key, { timer, to: data.userToCall, from: data.from, isAudio: !data.isVideo, transport: 'peer' });
            } catch (err) {}
        } catch (err) {
            console.error('Error handling call-user:', err, data);
        }
    });

    // Callee answers - expect: { signal: <simple-peer-signal>, to: <callerProfileId>, from: <calleeProfileId> }
    socket.on('answer-call', (data) => {
        try {
            console.log(`✅ answer-call from ${data.from} -> ${data.to}`);
            // Clear any pending missed-call timer for this peer call
            try {
                const key = `peer:${data.to}:${data.from}`; // (caller:calle)
                const entry = callTimeouts.get(key);
                if (entry) {
                    clearTimeout(entry.timer);
                    callTimeouts.delete(key);
                }
            } catch (e) {}
            const targetSocketId = onlineUsers.get(data.to);
            if (targetSocketId) {
                io.to(targetSocketId).emit('call-accepted', {
                    signal: data.signal, // raw signal from callee
                    from: data.from
                });
            } else {
                console.log('Caller not online to receive answer:', data.to);
            }
        } catch (err) {
            console.error('Error handling answer-call:', err, data);
        }
    });

    // End call
    socket.on('leaveVideoCall', async (friendId) => {
        try {
            const targetSocketId = onlineUsers.get(friendId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('videoCallEnd', friendId);
            }
            // Clear any pending missed-call timers for this caller<->friend pair
            try {
                for (const [key, entry] of callTimeouts.entries()) {
                    if (entry && entry.transport === 'agora' && entry.to === friendId && entry.from === profileId) {
                        clearTimeout(entry.timer);
                        callTimeouts.delete(key);
                    }
                }
            } catch (e) {}
            const roomKey = getRoomKey(profileId, friendId);
            const accepted = wasAccepted(roomKey);
            // Only send push for missed
            if (!accepted) {
                try {
                    await sendPushToProfile(friendId, {
                        title: 'Missed video call',
                        body: 'You missed a video call',
                        data: { type: 'missed_call', isVideo: 'true' }
                    });
                } catch (e) {}
            }

            // Create and emit a call message to both participants
            try {
                const room = roomKey;
                const callEvent = accepted ? 'ended' : 'missed';
                if (recordEventOnce(roomKey, 'video', callEvent)) {
                    const callMsg = new Message({
                        room,
                        senderId: String(profileId),
                        receiverId: String(friendId),
                        message: callEvent === 'missed' ? 'Missed video call' : 'Video call ended',
                        messageType: 'call',
                        callType: 'video',
                        callEvent
                    });
                    await callMsg.save();
                    const updatedMessage = await Message.findOne({ _id: callMsg._id }).populate('parent');
                    const profileData = await Profile.findById(profileId).populate('user');
                    if (profileData) {
                        const senderName = (profileData.user?.firstName || '') + ' ' + (profileData.user?.surname || '');
                        const senderPP = profileData.profilePic || 'https://programmerikram.com/wp-content/uploads/2025/03/default-profilePic.png';
                        io.to(room).emit('newMessage', { updatedMessage, senderName, senderPP, chatPage: true });
                        io.to(friendId).emit('newMessageToUser', { updatedMessage, senderName, senderPP, chatPage: false, friendProfile: profileData });
                    }
                }
            } catch (e) {
            }
            // Also notify the current socket so its own screens close
            socket.emit('videoCallEnd', friendId);
        } catch (err) {
            console.error('Error handling leaveVideoCall:', err, friendId);
        }
    });

    // End audio call
    socket.on('leaveAudioCall', async (friendId) => {
        try {
            const targetSocketId = onlineUsers.get(friendId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('audioCallEnd', friendId);
            }
            // Clear any pending missed-call timers for this caller<->friend pair
            try {
                for (const [key, entry] of callTimeouts.entries()) {
                    if (entry && entry.transport === 'agora' && entry.to === friendId && entry.from === profileId) {
                        clearTimeout(entry.timer);
                        callTimeouts.delete(key);
                    }
                }
            } catch (e) {}
            const roomKey = getRoomKey(profileId, friendId);
            const accepted = wasAccepted(roomKey);
            if (!accepted) {
                try {
                    await sendPushToProfile(friendId, {
                        title: 'Missed audio call',
                        body: 'You missed an audio call',
                        data: { type: 'missed_call', isVideo: 'false' }
                    });
                } catch (e) {}
            }

            // Create and emit a call message to both participants
            try {
                const room = roomKey;
                const callEvent = accepted ? 'ended' : 'missed';
                if (recordEventOnce(roomKey, 'audio', callEvent)) {
                    const callMsg = new Message({
                        room,
                        senderId: String(profileId),
                        receiverId: String(friendId),
                        message: callEvent === 'missed' ? 'Missed audio call' : 'Audio call ended',
                        messageType: 'call',
                        callType: 'audio',
                        callEvent
                    });
                    await callMsg.save();
                    const updatedMessage = await Message.findOne({ _id: callMsg._id }).populate('parent');
                    const profileData = await Profile.findById(profileId).populate('user');
                    if (profileData) {
                        const senderName = (profileData.user?.firstName || '') + ' ' + (profileData.user?.surname || '');
                        const senderPP = profileData.profilePic || 'https://programmerikram.com/wp-content/uploads/2025/03/default-profilePic.png';
                        io.to(room).emit('newMessage', { updatedMessage, senderName, senderPP, chatPage: true });
                        io.to(friendId).emit('newMessageToUser', { updatedMessage, senderName, senderPP, chatPage: false, friendProfile: profileData });
                    }
                }
            } catch (e) {
            }
            // Also notify the current socket so its own screens close
            socket.emit('audioCallEnd', friendId);
        } catch (err) {
            console.error('Error handling leaveAudioCall:', err, friendId);
        }
    });


};
