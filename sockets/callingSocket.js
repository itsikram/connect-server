const { isValidObjectId } = require('mongoose');
const Message = require('../models/Message')
const Profile = require('../models/Profile')
const checkIsActive = require('../utils/checkIsActive')
const axios = require('axios')


const sendEmailNotification = require('../utils/sendEmailNotification')

module.exports = function callingSocket(io, socket, profileId, onlineUsers) {


    // Agora calling socket

    socket.on("agora-video-call", async ({ to, channelName, isAudio = false }) => {
        console.log('agora-call-user', { to, channelName })
        let myProfileData = await Profile.findById(profileId)
        io.to(to).emit("agora-incoming-video-call", { from: profileId, channelName, isAudio, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
    });

    socket.on("agora-audio-call", async ({ to, channelName, isAudio = false }) => {
        console.log('agora-incoming-audio-call', { to, channelName })
        let myProfileData = await Profile.findById(profileId)
        io.to(to).emit("agora-incoming-audio-call", { from: profileId, channelName, isAudio, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
    });


    socket.on("agora-answer-call", ({ to, channelName, isAudio = false }) => {
        io.to(to).emit("agora-call-accepted", { channelName, isAudio });
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
    socket.on('leaveVideoCall', (friendId) => {
        try {
            const targetSocketId = onlineUsers.get(friendId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('videoCallEnd', friendId);
            }
        } catch (err) {
            console.error('Error handling leaveVideoCall:', err, friendId);
        }
    });

    // End audio call
    socket.on('leaveAudioCall', (friendId) => {
        try {
            const targetSocketId = onlineUsers.get(friendId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('audioCallEnd', friendId);
            }
        } catch (err) {
            console.error('Error handling leaveAudioCall:', err, friendId);
        }
    });


};
