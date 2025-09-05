// server/socketHandler.js
const messageSocket = require('./messageSocket');
const { notificationSocket } = require('../controllers/notificationController');
const Profile = require('../models/Profile');
const User = require('../models/User');
const Post = require('../models/Post');
const checkIsActive = require('../utils/checkIsActive');
const callingSocket = require('./callingSocket');

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

            // Message & notification socket modules
            try {
                messageSocket(io, socket, profileId);
                notificationSocket(io, socket, profileId);
                callingSocket(io, socket, profileId, onlineUsers);
            } catch (err) {
                console.error('Error initializing message/notification sockets:', err);
            }

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
