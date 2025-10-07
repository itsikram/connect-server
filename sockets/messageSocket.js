const { isValidObjectId } = require('mongoose');
const Message = require('../models/Message')
const Profile = require('../models/Profile')
const checkIsActive = require('../utils/checkIsActive')
const axios = require('axios')


const sendEmailNotification = require('../utils/sendEmailNotification')
const { sendPushToProfile } = require('../utils/pushNotifications')

module.exports = function messageSocket(io, socket, profileId) {

    socket.on('fetchMessages', async () => {

        let profileContacts = []
        let myProfile = await Profile.findOne({ _id: profileId }).populate('friends')

        console.log('fetchMessages pid', profileId,myProfile)

        if (!myProfile) return;
        if (myProfile?.friends !== null) {
            for (const friendProfile of myProfile.friends) {
                const messages = await Message.find({
                    senderId: friendProfile._id,
                    receiverId: profileId
                }).limit(1).sort({ timestamp: -1 })

                profileContacts.push({ person: friendProfile, messages })
            }
            console.log('profileContacts', profileContacts[0])
            io.to(profileId).emit('oldMessages', profileContacts)
        }

    })


    socket.on('startChat', async ({ user1, user2 }) => {
        const room = [user1, user2].sort().join('_'); // Ensures consistent room ID
        socket.join(room);

        const messages = await Message.find({ $or: [{ senderId: user1, receiverId: user2 }, { senderId: user2, receiverId: user1 }] }).sort({ timestamp: -1 }).limit(20).populate('parent');
        socket.emit('previousMessages', messages.reverse());
        socket.emit('roomJoined', { room });
    });


    socket.on('loadMessages', async ({ myId, friendId, skip }) => {
        let limit = 20
        if (skip < 1) {
            return io.to(myId).emit('loadMessages', { loadedMessages: [], skip: false })
        }
        const loadedMessages = await Message.find({ $or: [{ senderId: myId, receiverId: friendId }, { senderId: friendId, receiverId: myId }] }).skip(skip).limit(limit).sort({ timestamp: -1 }).populate('parent');
        let messagesLeft = await Message.find({ $or: [{ senderId: myId, receiverId: friendId }, { senderId: friendId, receiverId: myId }] }).skip(skip).limit(limit).sort({ timestamp: -1 })
        let hasNewMessage = messagesLeft.length < 1 ? false : true
        let msgList = loadedMessages.reverse()
        return io.to(myId).emit('loadMessages', { loadedMessages: msgList, hasNewMessage })
    })

    socket.on('fetchOldMessages', async ({ room, userId, page, limit, beforeTimestamp }) => {
        try {
            console.log('fetchOldMessages received:', { room, userId, page, limit, beforeTimestamp });
            
            // Parse the room to get both user IDs
            const [user1, user2] = room.split('_');
            
            // Build query for messages between these users before the given timestamp
            const query = {
                $or: [
                    { senderId: user1, receiverId: user2 },
                    { senderId: user2, receiverId: user1 }
                ],
                timestamp: { $lt: new Date(beforeTimestamp) }
            };

            // Calculate skip based on page
            const skip = (page - 1) * limit;

            // Fetch old messages
            const oldMessages = await Message.find(query)
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(limit)
                .populate('parent');

            // Check if there are more messages available
            const totalOldMessages = await Message.countDocuments(query);
            const hasMore = (skip + limit) < totalOldMessages;

            console.log('fetchOldMessages result:', { 
                foundMessages: oldMessages.length, 
                hasMore, 
                totalOldMessages, 
                skip, 
                limit 
            });

            // Emit the old messages
            socket.emit('oldMessages', oldMessages.reverse());
            
        } catch (error) {
            console.error('Error fetching old messages:', error);
            socket.emit('oldMessages', []);
        }
    });

    socket.on('deleteMessage', async (messageId) => {
        let deletedMessages = await Message.findOneAndDelete({ _id: messageId });
        if (deletedMessages) {
            io.to(deletedMessages.room).emit('deleteMessage', messageId);
        }
    })


    socket.on('reactMessage', async ({ messageId, profileId }) => {

        let reactedMessage = await Message.findOneAndUpdate({
            _id: messageId, reacts: {
                $nin: profileId
            }
        }, {
            $push: {
                reacts: profileId
            }
        }, { new: true })
        if (reactedMessage) {
            io.to(profileId).emit('messageReacted', messageId)

        }

    })

    socket.on('removeReactMessage', async ({ messageId, profileId }) => {

        let removedReactedMessage = await Message.findOneAndUpdate({ _id: messageId }, {
            $pull: {
                reacts: profileId
            }
        }, { new: true })

        if (removedReactedMessage) {
            io.to(profileId).emit('messageReactRemoved', messageId)

        }

    })

    socket.on('speak_message', async ({msgId,friendId}) => {
        let msgData = await Message.findById(msgId);
        if (msgData) {
            io.to(friendId).emit('speak_message', msgData.message);
        }
    });

    socket.on('sendMessage', async ({ room, senderId, receiverId, message, attachment, parent, isAi = false, messageType = 'text', callType, callEvent }) => {


        if (isAi) {
            try {
                const response = await axios.post(
                    'https://api.openai.com/v1/chat/completions',
                    {
                        model: 'gpt-3.5-turbo',
                        messages: [{ role: 'user', content: message }],
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );

                const reply = response.data.choices[0].message.content;
                console.log('ai reply', response.data)

                return io.to(room).emit('newMessage', { reply, senderName: 'Chat Gpt', senderPP: 'https://programmerikram.com/wp-content/uploads/2025/05/ics_logo.png' });


            } catch (error) {
                return console.error(error.response?.data || error.message);
            }

        }

        let newMessage;
        if (parent == false) {
            newMessage = new Message({ room, senderId, receiverId, message, attachment, messageType, callType, callEvent })
        } else {
            newMessage = new Message({ room, senderId, receiverId, message, attachment, parent, messageType, callType, callEvent })
        }
        await newMessage.save();

        let updatedMessage = await Message.findOne({ _id: newMessage._id }).populate('parent')
        let profileData = await Profile.findById(senderId).populate('user');
        if (!profileData) return;
        let senderName = profileData.user?.firstName + ' ' + profileData.user?.surname;
        let senderPP = profileData.profilePic || 'https://programmerikram.com/wp-content/uploads/2025/03/default-profilePic.png';
        io.to(room).emit('newMessage', { updatedMessage, senderName, senderPP, chatPage: true });

        let friendProfile = await Profile.findById(senderId).populate('user')
        io.to(receiverId).emit('newMessageToUser', { updatedMessage, senderName, senderPP, chatPage: false,friendProfile });

        let receiverProfile = await Profile.findById(receiverId).populate('user')

        let { isActive, lastLogin } = await checkIsActive(receiverId)

        // Send web notification for new messages (always send, regardless of activity status)
        if (String(receiverId) !== String(senderId)) {
            try {
                // Import the notification controller function
                const { saveNotification } = require('../controllers/notificationController');
                
                // Get all active browser IDs for the receiver
                const activeBrowserIds = receiverProfile.browserIds
                    ?.filter(browser => browser.isActive)
                    ?.map(browser => browser.browserId) || [];

                // Create notification data for web notifications
                const notificationData = {
                    receiverId: receiverId,
                    text: `${senderName}: ${updatedMessage.message}`,
                    link: `/message/${senderId}`,
                    icon: senderPP,
                    type: 'message',
                    browserIds: activeBrowserIds,
                    data: {
                        senderId: senderId,
                        messageId: updatedMessage._id,
                        room: room,
                        senderName: senderName,
                        senderProfilePic: senderPP
                    }
                };

                // Send notification using the existing notification system
                await saveNotification(io, notificationData);

                console.log(`Web notification sent for message to user ${receiverId}, browsers: ${activeBrowserIds.length}`);
            } catch (error) {
                console.error('Error sending web notification for message:', error);
            }
        }

        if (!isActive && String(receiverId) !== String(senderId)) {
            // Try push notification first; fallback to email if none sent
            try {
                const result = await sendPushToProfile(receiverId, {
                    title: senderName,
                    body: updatedMessage.message,
                    data: {
                        type: 'chat',
                        senderId: String(senderId),
                        receiverId: String(receiverId),
                        room: String(room),
                        messageId: String(updatedMessage._id),
                    },
                });
                if (result.successCount > 0) {
                    return; // delivered via push
                }
            } catch (e) {
                console.error('Push send failed, falling back to email:', e?.message || e);
            }

            let receiverEmail = receiverProfile.user.email;
            return sendEmailNotification(receiverEmail, null, updatedMessage.message, senderName, senderPP);
        }

    });

    socket.on('emotion_change', async ({ profileId, emotion, friendId, emotionText, emoji, confidence, quality }) => {
        console.log('emotion_change', profileId, emotion, friendId, emotionText, emoji, confidence, quality)
        
        try {
            // Add null checks and better error handling
            if (!profileId || !emotion || !friendId) {
                console.error('Missing required parameters for emotion_change:', { profileId, emotion, friendId });
                return;
            }

            let updateProfile = await Profile.findOneAndUpdate(
                { _id: profileId }, 
                { 
                    lastEmotion: emotion,
                    lastEmotionText: emotionText || emotion,
                    lastEmotionEmoji: emoji,
                    lastEmotionConfidence: confidence,
                    lastEmotionQuality: quality
                }, 
                { new: true }
            );
            
            if (updateProfile) {
                // Emit emotion change with all the data
                io.to(friendId).emit('emotion_change', {
                    profileId: updateProfile._id,
                    emotion: updateProfile.lastEmotion,
                    emotionText: updateProfile.lastEmotionText,
                    emoji: updateProfile.lastEmotionEmoji,
                    confidence: updateProfile.lastEmotionConfidence,
                    quality: updateProfile.lastEmotionQuality,
                    timestamp: new Date()
                });
                console.log('Emotion change emitted successfully:', updateProfile.lastEmotion);
            } else {
                console.error('Failed to update profile for emotion_change:', profileId);
            }
        } catch (error) {
            console.error('Error in emotion_change handler:', error);
        }
    })

    socket.on('typing', ({ room, isTyping, type, receiverId }) => {
        console.log('typing', room, isTyping, type, receiverId)
        if (isTyping) {
            socket.to(room).emit('typing', { receiverId, isTyping: true, type });
        } else {
            socket.to(room).emit('typing', { receiverId, isTyping: false });
        }
        // socket.to(room).emit('typing');
    }
    );

    socket.on('update_type', ({ room, type }) => {
        io.to(room).emit('update_type', { type });
    })

    socket.on('seenMessage', async (message) => {
        // let msgId = message._id;
        if (message?._id) {
            let msg = await Message.findOneAndUpdate({ _id: message._id }, { isSeen: true }, { new: true });
            if (msg) {
                io.to(message.room).emit('seenMessage', msg);
            }
        }
    });

    socket.on('last_emotion', async ({ friendId, profileId }) => {

        if (!isValidObjectId(friendId) && !isValidObjectId(profileId)) return;

        let profileData = await Profile.findOne({ _id: friendId }).select('lastEmotion')
        if (profileData) {
            io.to(profileId).emit('last_emotion', profileData)
        }

    })

    // Live voice relays (push-to-talk over Agora)
    socket.on('agora-live-voice-start', ({ to, channelName }) => {
        try {
            io.to(to).emit('agora-live-voice-start', { from: profileId, channelName });
        } catch (e) {
            console.error('agora-live-voice-start relay failed:', e?.message || e);
        }
    });

    socket.on('agora-live-voice-stop', ({ to, channelName }) => {
        try {
            io.to(to).emit('agora-live-voice-stop', { from: profileId, channelName });
        } catch (e) {
            console.error('agora-live-voice-stop relay failed:', e?.message || e);
        }
    });



};
