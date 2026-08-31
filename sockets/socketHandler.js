// server/socketHandler.js
const messageSocket = require('./messageSocket');
const { notificationSocket } = require('../controllers/notificationController');
const Profile = require('../models/Profile');
const User = require('../models/User');
const Post = require('../models/Post');
const checkIsActive = require('../utils/checkIsActive');
const updateLastActive = require('../utils/updateLastActive');
const callingSocket = require('./callingSocket');
const { sendBump } = require('../utils/sendBump');
const ludoSocket = require('./ludoSocket');
const chessSocket = require('./chessSocket');

module.exports = function socketHandler(io) {
    // profileId -> socketId
    const onlineUsers = new Map();
    // profileId -> Set of socketIds (to track multiple connections per user)
    const profileSockets = new Map();
    // profileId -> timeoutId (to track pending offline timeouts)
    const offlineTimeouts = new Map();

    io.on('connection', async (socket) => {
        const profileId = socket.handshake.query?.profile;
        const browserId = socket.handshake.query?.browserId;

        if (profileId && profileId !== 'undefined') {
            socket.join(String(profileId));
            
            // Cancel any pending offline timeout if user reconnects
            if (offlineTimeouts.has(profileId)) {
                clearTimeout(offlineTimeouts.get(profileId));
                offlineTimeouts.delete(profileId);
            }
            
            // Track multiple socket connections per profile
            if (!profileSockets.has(profileId)) {
                profileSockets.set(profileId, new Set());
            }
            profileSockets.get(profileId).add(socket.id);
            onlineUsers.set(profileId, socket.id);

            let profileFriends = await Profile.findById(profileId) || []

            // Update user's lastLogin and isActive status on connection
            try {
                await User.findOneAndUpdate(
                    { profile: profileId },
                    { lastLogin: Date.now() },
                    { new: true }
                );
                await Profile.findOneAndUpdate(
                    { _id: profileId },
                    { isActive: true, lastActive: new Date() },
                    { new: true }
                );
            } catch (err) {
                console.error('Error updating user activity on connection:', err);
            }

            // Join browser-specific room if browserId is provided
            if (browserId && browserId !== 'undefined') {
                socket.join(`browser_${browserId}`);
            }

            // Emit friend_online to all friends (regardless of browserId)
            try {
                if (profileFriends && profileFriends.friends && profileFriends.friends.length > 0) {
                    profileFriends.friends.forEach(friend => {
                        io.to(String(friend)).emit('friend_online', { profileId });
                    });
                }
            } catch (err) {
                console.error('Error emitting friend_online:', err);
            }



            // Message & notification socket modules
            try {
                messageSocket(io, socket, profileId);
                notificationSocket(io, socket, profileId);
                callingSocket(io, socket, profileId, onlineUsers);
                ludoSocket(io, socket, profileId);
                chessSocket(io, socket, profileId);
            } catch (err) {
                console.error('Error initializing message/notification sockets:', err);
            }

        }

        // View post tracking
        socket.on('viewPost', async ({ visitorId, postId }) => {
            try {
                await Post.findOneAndUpdate(
                    { _id: postId, viewers: { $ne: visitorId } },
                    { $push: { viewers: visitorId } }
                );
                // Update last active time for viewing posts
                await updateLastActive(visitorId);
            } catch (err) {
                console.error('Error updating post viewers:', err);
            }
        });

        // bump notification
        socket.on('bump', async ({ friendProfile, myProfile }) => {
            try {
                const fromId = myProfile || profileId;
                await sendBump(io, { friendProfile, myProfile: fromId });
            } catch (err) {
                console.error('bump emit error', err);
            }
        });

        // Check active status
        socket.on('is_active', async ({ profileId: targetProfileId, myId }) => {
            if (!targetProfileId || targetProfileId.length < 5) return;
            try {
                // First check if user is currently connected via socket (most accurate)
                const isCurrentlyOnline = onlineUsers.has(targetProfileId);
                
                let isActive = false;
                let lastLogin = null;
                
                if (isCurrentlyOnline) {
                    // User is currently connected, so they're definitely active
                    isActive = true;
                    // Get lastLogin from database for display purposes
                    try {
                        const user = await User.findOne({ profile: targetProfileId });
                        if (user && user.lastLogin) {
                            lastLogin = user.lastLogin;
                        } else {
                            // Fallback to current time if no lastLogin found
                            lastLogin = Date.now();
                        }
                    } catch (err) {
                        console.error('Error fetching lastLogin for online user:', err);
                        lastLogin = Date.now();
                    }
                } else {
                    // User is not connected, check database for last activity
                    const result = await checkIsActive(targetProfileId);
                    isActive = result.isActive;
                    lastLogin = result.lastLogin;
                }
                
                io.to(myId).emit('is_active', isActive, lastLogin, targetProfileId);
            } catch (err) {
                console.error('Error checking active status:', err);
                // Emit false status on error
                io.to(myId).emit('is_active', false, Date.now(), targetProfileId);
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

                // Update last active time for location update
                await updateLastActive(senderProfileId);

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
                    // Remove this socket from profile's socket set
                    let hasOtherSockets = false;
                    if (profileSockets.has(profileId)) {
                        profileSockets.get(profileId).delete(socket.id);
                        
                        // If user still has other active sockets, don't set offline
                        if (profileSockets.get(profileId).size > 0) {
                            hasOtherSockets = true;
                            console.log(`📱 Profile ${profileId} still has ${profileSockets.get(profileId).size} active socket(s), not setting offline`);
                        } else {
                            // No more sockets for this profile, clean up
                            profileSockets.delete(profileId);
                        }
                    }
                    
                    // If user still has other active sockets, skip offline logic
                    if (hasOtherSockets) {
                        onlineUsers.delete(profileId);
                        return;
                    }
                    
                    // Update lastLogin on disconnect
                    await User.findOneAndUpdate(
                        { profile: profileId },
                        { lastLogin: Date.now() },
                        { new: true }
                    );
                    
                    // Cancel any existing timeout for this profile
                    if (offlineTimeouts.has(profileId)) {
                        clearTimeout(offlineTimeouts.get(profileId));
                    }
                    
                    // Set a 5-minute timeout before marking offline
                    const timeoutId = setTimeout(async () => {
                        try {
                            // Check if lastLogin is more than 5 minutes old
                            const user = await User.findOne({ profile: profileId });
                            if (!user) {
                                console.error(`User not found for profile ${profileId}`);
                                return;
                            }
                            
                            const currentTime = Date.now();
                            const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
                            const timeSinceLastLogin = currentTime - (user.lastLogin || 0);
                            
                            // Only set offline if lastLogin is more than 5 minutes old
                            if (timeSinceLastLogin >= fiveMinutes) {
                                // Check again if user has reconnected (has active sockets)
                                if (profileSockets.has(profileId) && profileSockets.get(profileId).size > 0) {
                                    console.log(`⏰ Profile ${profileId} reconnected before timeout, skipping offline update`);
                                    return;
                                }
                                
                                await Profile.findOneAndUpdate(
                                    { _id: profileId },
                                    { isActive: false }
                                );
                                
                                // Notify friends that user is offline
                                let profileFriends = await Profile.findById(profileId);
                                if (profileFriends && profileFriends.friends && profileFriends.friends.length > 0) {
                                    profileFriends.friends.forEach(friend => {
                                        console.log('friend_offline', String(friend), profileId);
                                        io.to(String(friend)).emit('friend_offline', { profileId });
                                    });
                                }
                                
                                console.log(`⏰ Profile ${profileId} marked offline after 5 minutes (lastLogin was ${Math.round(timeSinceLastLogin / 1000 / 60)} minutes ago)`);
                            } else {
                                console.log(`⏰ Profile ${profileId} timeout expired but lastLogin is only ${Math.round(timeSinceLastLogin / 1000)} seconds old, keeping online`);
                            }
                            
                            offlineTimeouts.delete(profileId);
                        } catch (err) {
                            console.error('Error in offline timeout handler:', err);
                            offlineTimeouts.delete(profileId);
                        }
                    }, 5 * 60 * 1000); // 5 minutes
                    
                    offlineTimeouts.set(profileId, timeoutId);
                    console.log(`⏰ Set 5-minute offline timeout for profile ${profileId}`);
                    
                    onlineUsers.delete(profileId);
                } catch (err) {
                    console.error('Error handling disconnect:', err);
                    // Clean up on error
                    if (profileSockets.has(profileId)) {
                        profileSockets.get(profileId).delete(socket.id);
                        if (profileSockets.get(profileId).size === 0) {
                            profileSockets.delete(profileId);
                        }
                    }
                    onlineUsers.delete(profileId);
                }
            }
        });
    });
};
