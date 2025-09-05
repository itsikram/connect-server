const { isValidObjectId } = require('mongoose');
const Message = require('../models/Message')
const Profile = require('../models/Profile')
const checkIsActive = require('../utils/checkIsActive')
const axios = require('axios')
const { sendPushToProfile } = require('../utils/pushNotifications')


const sendEmailNotification = require('../utils/sendEmailNotification')

module.exports = function callingSocket(io, socket, profileId, onlineUsers) {


    // Agora calling socket

    socket.on("agora-video-call", async ({ to, channelName, isAudio = false }) => {
        console.log('agora-call-user', { to, channelName })
        let myProfileData = await Profile.findById(profileId)
        io.to(to).emit("agora-incoming-video-call", { from: profileId, channelName, isAudio: false, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
        // Push notification so callee sees incoming call outside the app
        try {
            await sendPushToProfile(to, {
                title: `Incoming video call`,
                body: `${myProfileData.fullName} is calling…`,
                data: {
                    type: 'incoming_call',
                    isAudio: 'false',
                    from: String(profileId),
                    callerName: myProfileData.fullName || '',
                    callerProfilePic: myProfileData.profilePic || '',
                    channelName: channelName || ''
                }
            });
        } catch (e) {}
    });

    socket.on("agora-audio-call", async ({ to, channelName, isAudio = true }) => {
        console.log('agora-incoming-audio-call', { to, channelName })
        let myProfileData = await Profile.findById(profileId)
        io.to(to).emit("agora-incoming-audio-call", { from: profileId, channelName, isAudio: true, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
        // Push notification so callee sees incoming call outside the app
        try {
            await sendPushToProfile(to, {
                title: `Incoming audio call`,
                body: `${myProfileData.fullName} is calling…`,
                data: {
                    type: 'incoming_call',
                    isAudio: 'true',
                    from: String(profileId),
                    callerName: myProfileData.fullName || '',
                    callerProfilePic: myProfileData.profilePic || '',
                    channelName: channelName || ''
                }
            });
        } catch (e) {}
    });


    socket.on("agora-answer-call", async ({ to, channelName, isAudio = false }) => {
        try {
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
        } catch (err) {
            console.error('Error handling call-user:', err, data);
        }
    });

    // Callee answers - expect: { signal: <simple-peer-signal>, to: <callerProfileId>, from: <calleeProfileId> }
    socket.on('answer-call', (data) => {
        try {
            console.log(`✅ answer-call from ${data.from} -> ${data.to}`);
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
            try {
                await sendPushToProfile(friendId, {
                    title: 'Missed video call',
                    body: 'You missed a video call',
                    data: { type: 'missed_call', isVideo: 'true' }
                });
            } catch (e) {}
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
            try {
                await sendPushToProfile(friendId, {
                    title: 'Missed audio call',
                    body: 'You missed an audio call',
                    data: { type: 'missed_call', isVideo: 'false' }
                });
            } catch (e) {}
            // Also notify the current socket so its own screens close
            socket.emit('audioCallEnd', friendId);
        } catch (err) {
            console.error('Error handling leaveAudioCall:', err, friendId);
        }
    });


};
