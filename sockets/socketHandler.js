// server/socketHandler.js
const messageSocket = require('./messageSocket');
const { notificationSocket } = require('../controllers/notificationController');
const Profile = require('../models/Profile');
const User = require('../models/User');
const Post = require('../models/Post');
const checkIsActive = require('../utils/checkIsActive');

module.exports = function socketHandler(io) {
    // profileId -> socketId
    const onlineUsers = new Map();

    io.on('connection', async (socket) => {
        const profileId = socket.handshake.query?.profile;
        if (profileId !== 'undefined') {
            socket.join(profileId);
            console.log('profileId', profileId);
            await Profile.findOneAndUpdate({ _id: profileId }, { isActive: true }, { new: true });
            onlineUsers.set(profileId, socket.id);


            
        socket.on("agora-call-user", async ({ to, channelName, isAudio = false }) => {
            console.log('agora-call-user', { to, channelName })
            let myProfileData = await Profile.findById(profileId)
            io.to(to).emit("agora-incoming-call", { from: profileId, channelName, isAudio, callerName: myProfileData.fullName, callerProfilePic: myProfileData.profilePic });
        });


        socket.on("agora-answer-call", ({ to, channelName }) => {
            io.to(to).emit("agora-call-accepted", { channelName });
        });

        socket.on("agora-filter-video", ({ to, filter }) => {
            io.to(to).emit("agora-apply-video-filter", { filter });
        });

        console.log(`✅ Socket connected: ${socket.id} (profile: ${profileId})`);



        } else {
            console.log(`✅ Socket connected: ${socket.id} (no profile in handshake query)`);
        }


        // View post tracking
        socket.on('viewPost', async ({ visitorId, postId }) => {
            try {
                await Post.findOneAndUpdate(
                    { _id: postId, viewers: { $ne: visitorId } },
                    { $push: { viewers: visitorId } }
                );
            } catch (err) {
                console.error('Error updating post viewers:', err);
            }
        });

        // bump notification
        socket.on('bump', async ({ friendProfile, myProfile }) => {
            try {
                // console.log('bump', friendProfile, myProfile)
                let friendProfileData = await Profile.findById(friendProfile)
                let myProfileData = await Profile.findById(myProfile)
                io.to(friendProfile).emit('bumpUser', { friendProfileData, myProfileData });
            } catch (err) {
                console.error('bump emit error', err);
            }
        });

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

        // Message & notification socket modules
        try {
            messageSocket(io, socket);
            notificationSocket(io, socket, profileId);
        } catch (err) {
            console.error('Error initializing message/notification sockets:', err);
        }

        // Update last login
        socket.on('update_last_login', async (userId) => {
            if (!userId) return;
            try {
                await User.findOneAndUpdate(
                    { _id: userId },
                    { lastLogin: Date.now() },
                    { new: true }
                );
            } catch (err) {
                console.error('Error updating last login:', err);
            }
        });

        // Check active status
        socket.on('is_active', async ({ profileId: targetProfileId, myId }) => {
            if (!targetProfileId || targetProfileId.length < 5) return;
            try {
                const { isActive, lastLogin } = await checkIsActive(targetProfileId);
                io.to(myId).emit('is_active', isActive, lastLogin, targetProfileId);
            } catch (err) {
                console.error('Error checking active status:', err);
            }
        });

        // Disconnect
        socket.on('disconnect', async () => {
            console.log(`🔌 Socket disconnected: ${socket.id}`);

            if (profileId !== 'undefined') {
                try {
                    await User.findOneAndUpdate(
                        { profile: profileId },
                        { lastLogin: Date.now() },
                        { new: true }
                    );
                } catch (err) {
                    console.error('Error updating last login:', err);
                }
                await Profile.findOneAndUpdate(
                    { _id: profileId },
                    { isActive: false }
                );
                onlineUsers.delete(profileId);
            }
        });
    });
};
