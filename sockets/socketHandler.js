// server/socketHandler.js
const messageSocket = require('./messageSocket');
const { notificationSocket } = require('../controllers/notificationController');
const Profile = require('../models/Profile');
const User = require('../models/User');
const Post = require('../models/Post');
const checkIsActive = require('../utils/checkIsActive');
const callingSocket = require('./callingSocket');
const { sendPushToProfile } = require('../utils/pushNotifications');
const ludoSocket = require('./ludoSocket');

module.exports = function socketHandler(io) {
    // profileId -> socketId
    const onlineUsers = new Map();

    io.on('connection', async (socket) => {
        const profileId = socket.handshake.query?.profile;
        const browserId = socket.handshake.query?.browserId;

        if (profileId !== 'undefined') {
            socket.join(profileId);
            console.log('profileId', profileId);
            // await Profile.findOneAndUpdate({ _id: profileId }, { isActive: true }, { new: true });
            // await User.findOneAndUpdate({ profile: profileId }, { lastLogin: Date.now() }, { new: true });
            let profileFriends = await Profile.findById(profileId) || []
            onlineUsers.set(profileId, socket.id);

            // Join browser-specific room if browserId is provided
            if (browserId && browserId !== 'undefined') {
                socket.join(`browser_${browserId}`);
                console.log(`Browser ${browserId} joined room for profile ${profileId}`);

                // Update browser activity in database
                try {
                    // await Profile.findOneAndUpdate(
                    //     { _id: profileId, 'browserIds.browserId': browserId },
                    //     {
                    //         $set: {
                    //             'browserIds.$.lastActive': new Date(),
                    //             'browserIds.$.isActive': true
                    //         }
                    //     }
                    // );

                    // Emit friend_active to all friends
                    if (profileFriends && profileFriends.friends && profileFriends.friends.length > 0) {
                        profileFriends.friends.forEach(friend => {
                            console.log('friend_online', String(friend), profileId);
                            io.to(String(friend)).emit('friend_online', { profileId });
                        });
                    }
                } catch (err) {
                    console.error('Error updating browser activity:', err);
                }
            }



            // Message & notification socket modules
            try {
                messageSocket(io, socket, profileId);
                notificationSocket(io, socket, profileId);
                callingSocket(io, socket, profileId, onlineUsers);
                ludoSocket(io, socket, profileId);
            } catch (err) {
                console.error('Error initializing message/notification sockets:', err);
            }

            console.log(`✅ Socket connected: ${socket.id} (profile: ${profileId}, browser: ${browserId || 'none'})`);


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
                if (String(friendProfile) === String(myProfile)) return;
                // console.log('bump', friendProfile, myProfile)
                let friendProfileData = await Profile.findById(friendProfile)
                let myProfileData = await Profile.findById(myProfile)
                io.to(friendProfile).emit('bumpUser', { friendProfileData, myProfileData });
                try {
                    await sendPushToProfile(friendProfile, {
                        title: 'You were bumped!',
                        body: `${myProfileData.fullName} bumped you`,
                        data: { type: 'bump', senderId: String(myProfile) }
                    });
                } catch (e) { }
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

        // Location update handler
        socket.on('location_update', async ({ profileId: senderProfileId, location }) => {
            try {
                if (!senderProfileId || !location) {
                    console.error('Invalid location_update data:', { senderProfileId, location });
                    return;
                }

                // Update profile location in database
                const updatedProfile = await Profile.findByIdAndUpdate(
                    { _id: senderProfileId },
                    {
                        lastLocation: {
                            latitude: location.latitude,
                            longitude: location.longitude,
                            timestamp: location.timestamp || Date.now(),
                            accuracy: location.accuracy,
                        }
                    },
                    { new: true }
                );

                if (!updatedProfile) {
                    console.error('Profile not found for location update:', senderProfileId);
                    return;
                }

                // Get user's friends to broadcast location update
                const profile = await Profile.findById(senderProfileId).select('friends');
                if (profile && profile.friends && profile.friends.length > 0) {
                    console.log('📍 Broadcasting location update to', profile.friends.length, 'friends');
                    // Emit location update to all friends
                    profile.friends.forEach(friendId => {
                        const friendIdStr = String(friendId);
                        const locationUpdateData = {
                            profileId: senderProfileId,
                            location: {
                                latitude: location.latitude,
                                longitude: location.longitude,
                                timestamp: location.timestamp || Date.now(),
                                accuracy: location.accuracy,
                            }
                        };
                        io.to(friendIdStr).emit('friend_location_update', locationUpdateData);
                        console.log('📍 Location update sent to friend room:', friendIdStr, 'for profile:', senderProfileId);
                    });
                } else {
                    console.log('📍 No friends found for profile:', senderProfileId);
                }

                console.log('📍 Location updated for profile:', senderProfileId);
            } catch (err) {
                console.error('Error handling location_update:', err);
            }
        });

        // Disconnect
        socket.on('disconnect', async () => {
            console.log(`🔌 Socket disconnected: ${socket.id}`);

            if (profileId !== 'undefined') {
                try {

                    let profileFriends =  await Profile.findById(profileId);
                    if (profileFriends && profileFriends.friends && profileFriends.friends.length > 0) {
                        profileFriends.friends.forEach(friend => {
                            console.log('friend_offline', String(friend), profileId);
                            io.to(String(friend)).emit('friend_offline', { profileId });
                        });
                    }
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
