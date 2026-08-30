const Message = require('../models/Message')
const Profile = require('../models/Profile')
const { sendChatMessageDataPush } = require('../utils/pushNotifications')


exports.removeMessageReact = async (req, res, next) => {
    try {
        let io = req.app.get('io')
        let messageId = req.body.messageId
        let myId = req.body.myId

        let message = await Message.findOne({ _id: messageId })

        if (message) {
            let reactRemovedMessage = await Message.findOneAndUpdate({
                _id: messageId
            },{
                $pull: {
                    reacts: myId
                }
            },{new: true})

            if(reactRemovedMessage) {
                let receverId = message.receiverId == myId ? message.senderId : message.receiverId
                io.to(receverId).emit('messageReactRemoved', messageId)

                return res.json({message: 'Message React Removed'}).status(200)
            }
        }
        return res.json({message: 'Message React Removing Failed'}).status(400)

    } catch (error) {
        next(error)
    }
}
exports.addMessageReact = async (req, res, next) => {

    try {
        let io = req.app.get('io')
        let messageId = req.body.messageId
        let myId = req.body.myId

        let message = await Message.findOne({ _id: messageId })

        if (message) {
            let reactedMessage = await Message.findOneAndUpdate({
                _id: messageId, reacts: {
                    $nin: myId
                }
            }, {
                $push: {
                    reacts: myId
                }
            }, { new: true })


            if(reactedMessage) {
                let receverId = message.receiverId == myId ? message.senderId : message.receiverId
                io.to(receverId).emit('messageReacted', messageId)

                return res.json({message: 'Message React Added'}).status(200)
            }
        }
        return res.json({message: 'Message React Adding Failed'}).status(400)

    } catch (error) {
        next(error)
    }

}

exports.getMedia = async(req,res,next) => {

    try {
        const fileUrlRegex = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
        let getMessages = await Message.find({
            $or: [
                { senderId: req.profile._id, receiverId: req.query.profileId },
                { senderId: req.query.profileId, receiverId: req.profile._id }
            ],
            attachment: { $regex: fileUrlRegex }
        }).sort({ createdAt: -1 }).limit(10)

        res.json(getMessages).status(200)
        
    } catch (error) {
        next(error)
        
    }
}

exports.getChatList = async(req,res,next) => {
    // Set a timeout for the entire operation
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            res.status(408).json({ message: 'Request timeout' });
        }
    }, 8000); // 8 second timeout

    try {
        let profileId = req.query.profileId || req.profile._id;
        const now = new Date();

        // Use aggregation pipeline for better performance
        const lastMessages = await Message.aggregate([
            {
                $match: {
                    $or: [
                        { senderId: profileId },
                        { receiverId: profileId }
                    ]
                }
            },
            {
                $addFields: {
                    otherUserId: {
                        $cond: {
                            if: { $eq: ['$senderId', profileId] },
                            then: '$receiverId',
                            else: '$senderId'
                        }
                    }
                }
            },
            {
                $match: {
                    otherUserId: { $ne: null }
                }
            },
            {
                $sort: { timestamp: -1 }
            },
            {
                $group: {
                    _id: '$otherUserId',
                    lastMessage: { $first: '$$ROOT' }
                }
            }
        ]);

        // Get profile with friends
        const myProfile = await Profile.findOne({ _id: profileId }).populate('friends');
        
        if (!myProfile) {
            clearTimeout(timeout);
            return res.status(400).json({ message: 'Profile Not Found' });
        }

        if (myProfile?.friends == null || myProfile.friends.length === 0) {
            clearTimeout(timeout);
            return res.status(200).json({ message: 'No Friends Found' });
        }

        // Create a map for quick lookup of last messages
        const messageMap = new Map();
        lastMessages.forEach(msg => {
            if (msg._id != null) {
                messageMap.set(msg._id.toString(), msg.lastMessage);
            }
        });

        // Build profile contacts array
        const profileContacts = myProfile.friends.map(friendProfile => {
            const lastActive = friendProfile.lastActive ? new Date(friendProfile.lastActive) : null;
            const isOnline = lastActive && (now - lastActive) < 5 * 60 * 1000;
            
            return {
                person: friendProfile,
                messages: messageMap.get(friendProfile._id.toString()) ? [messageMap.get(friendProfile._id.toString())] : [],
                isOnline: isOnline,
                lastSeen: lastActive
            };
        });

        // Sort by last message timestamp
        profileContacts.sort((a, b) => {
            const aTimestamp = a.messages?.[0]?.timestamp 
                ? new Date(a.messages[0].timestamp).getTime() 
                : 0;
            const bTimestamp = b.messages?.[0]?.timestamp 
                ? new Date(b.messages[0].timestamp).getTime() 
                : 0;
            
            return bTimestamp - aTimestamp;
        });

        clearTimeout(timeout);
        return res.status(200).json(profileContacts);
        
    } catch (error) {
        clearTimeout(timeout);
        console.error('Error in getChatList:', error);
        if (!res.headersSent) {
            return next(error);
        }
    }
}
exports.getChatHistory = async(req,res,next) => {
    try {
        let profileId = req.query.profileId || req.profile._id
        let friendId = req.query.friendId
        let limit = parseInt(req.query.limit) || 20
        let skip = parseInt(req.query.skip) || 0
                
        // Build query for messages between these users
        const query = {
            $or: [
                { senderId: profileId, receiverId: friendId },
                { senderId: friendId, receiverId: profileId }
            ]
        };

        // Fetch messages (most recent first, then reverse for chronological order)
        const messages = await Message.find(query)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(limit)
            .populate('parent');

        // Check if there are more messages available
        const totalMessages = await Message.countDocuments(query);
        const hasMore = totalMessages > limit;

        console.log('getChatHistory result:', { 
            foundMessages: messages.length, 
            hasMore, 
            totalMessages, 
            limit 
        });

        // Return messages in chronological order (oldest first)
        res.status(200).json({
            messages: messages.reverse(),
            hasMore
        });
        
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(400).json({ messages: [], hasMore: false });
    }
}

exports.getOldMessages = async(req,res,next) => {
    try {
        let profileId = req.query.profileId || req.profile._id
        let friendId = req.query.friendId
        let limit = parseInt(req.query.limit) || 20
        let beforeTimestamp = req.query.beforeTimestamp
        
        // Validate required parameters
        if (!friendId) {
            return res.status(400).json({ 
                messages: [], 
                hasMore: false,
                error: 'friendId is required'
            });
        }
        
        if (!beforeTimestamp) {
            return res.status(400).json({ 
                messages: [], 
                hasMore: false,
                error: 'beforeTimestamp is required'
            });
        }
        
        // Validate timestamp
        const timestamp = new Date(beforeTimestamp);
        if (isNaN(timestamp.getTime())) {
            return res.status(400).json({ 
                messages: [], 
                hasMore: false,
                error: 'Invalid timestamp format'
            });
        }
        
        // Ensure limit is within reasonable bounds
        if (limit > 100) limit = 100;
        if (limit < 1) limit = 20;
                
        // Build query for messages between these users before the given timestamp
        const query = {
            $or: [
                { senderId: profileId, receiverId: friendId },
                { senderId: friendId, receiverId: profileId }
            ],
            timestamp: { $lt: timestamp }
        };

        // Fetch old messages (most recent first, then reverse for chronological order)
        const messages = await Message.find(query)
            .sort({ timestamp: -1 })
            .limit(limit + 1) // Fetch one extra to check if there are more
            .populate('parent');

        // Check if there are more messages available
        const hasMore = messages.length > limit;
        const resultMessages = messages.slice(0, limit); // Take only the limit

        console.log('getOldMessages result:', { 
            profileId,
            friendId,
            beforeTimestamp,
            foundMessages: resultMessages.length, 
            hasMore, 
            totalFetched: messages.length,
            limit 
        });

        // Return messages in chronological order (oldest first)
        res.status(200).json({
            messages: resultMessages.reverse(),
            hasMore
        });
        
    } catch (error) {
        console.error('Error fetching old messages:', error);
        res.status(500).json({ 
            messages: [], 
            hasMore: false,
            error: error.message 
        });
    }
}




// Generate a unique room ID using user IDs

// HTTP-based message sending
exports.sendMessage = async (req, res, next) => {
    try {
        const io = req.app.get('io');
        const { room, senderId, receiverId, message, attachment, parent, isAi = false, messageType = 'text', callType, callEvent, tempId } = req.body;

        // Prevent messaging if either user has blocked the other
        const [senderProfile, receiverProfile] = await Promise.all([
            Profile.findById(senderId).select('blockedUsers'),
            Profile.findById(receiverId).select('blockedUsers'),
        ]);
        
        const senderBlockedReceiver = senderProfile?.blockedUsers?.some(id => String(id) === String(receiverId));
        const receiverBlockedSender = receiverProfile?.blockedUsers?.some(id => String(id) === String(senderId));
        
        if (senderBlockedReceiver || receiverBlockedSender) {
            return res.status(403).json({
                message: 'Message blocked',
                reason: senderBlockedReceiver ? 'You blocked this user' : 'You are blocked by this user'
            });
        }

        let newMessage;
        if (parent == false) {
            newMessage = new Message({ room, senderId, receiverId, message, attachment, messageType, callType, callEvent, tempId });
        } else {
            newMessage = new Message({ room, senderId, receiverId, message, attachment, parent, messageType, callType, callEvent, tempId });
        }
        await newMessage.save();

        // Update last active time for sending message
        await updateLastActive(senderId);

        let updatedMessage = await Message.findOne({ _id: newMessage._id }).populate('parent');
        let profileData = await Profile.findById(senderId).populate('user');
        
        if (!profileData) {
            return res.status(404).json({ message: 'Sender profile not found' });
        }
        
        let senderName = profileData.user?.firstName + ' ' + profileData.user?.surname;
        let senderPP = profileData.profilePic || '/default-avatar.png';
        
        // Emit via socket for real-time updates
        io.to(room).emit('newMessage', { updatedMessage, senderName, senderPP, chatPage: true });
        
        let friendProfile = await Profile.findById(senderId).populate('user');
        io.to(receiverId).emit('newMessageToUser', { updatedMessage, senderName, senderPP, chatPage: false, friendProfile });

        // Data-only FCM so the receiver gets a notification when the app is swiped away / killed (no socket).
        try {
            if (String(receiverId) !== String(senderId) && friendProfile) {
                await sendChatMessageDataPush(receiverId, {
                    senderId,
                    updatedMessage,
                    senderName,
                    senderPP,
                    friendProfile,
                    room,
                });
            }
        } catch (pushErr) {
            console.error('HTTP sendMessage: FCM chat push failed:', pushErr?.message || pushErr);
        }

        return res.status(200).json({
            message: 'Message sent successfully',
            data: updatedMessage
        });

    } catch (error) {
        console.error('Error sending message:', error);
        next(error);
    }
};

// Helper function to update last active time
const updateLastActive = async (userId) => {
    try {
        await Profile.findByIdAndUpdate(userId, { lastActive: new Date() });
    } catch (error) {
        console.error('Error updating last active time:', error);
    }
};

// HTTP-based new messages polling
exports.getNewMessages = async (req, res, next) => {
    try {
        const { profileId, friendId, lastMessageId } = req.query;
        
        if (!profileId) {
            return res.status(400).json({ messages: [] });
        }

        let query;
        
        if (friendId) {
            // Get messages between two specific users (for Chat.js)
            query = {
                $or: [
                    { senderId: profileId, receiverId: friendId },
                    { senderId: friendId, receiverId: profileId }
                ]
            };
            
            // If we have a lastMessageId, only get messages newer than that
            if (lastMessageId) {
                const lastMessage = await Message.findById(lastMessageId);
                if (lastMessage) {
                    query.timestamp = { $gt: lastMessage.timestamp };
                }
            }
        } else {
            // Get all new messages for the user (for Main.js)
            query = {
                receiverId: profileId,
                isSeen: false
            };
            
            // If we have a lastMessageId, only get messages newer than that
            if (lastMessageId) {
                const lastMessage = await Message.findById(lastMessageId);
                if (lastMessage) {
                    query.timestamp = { $gt: lastMessage.timestamp };
                }
            }
        }
        
        // Fetch new messages (newest first)
        const newMessages = await Message.find(query)
            .sort({ timestamp: -1 })
            .limit(20)
            .populate('parent');
        
        // Enrich messages with sender profile information
        const enrichedMessages = await Promise.all(
            newMessages.map(async (msg) => {
                const msgObj = msg.toObject();
                try {
                    const senderProfile = await Profile.findById(msg.senderId).select('name profilePic');
                    if (senderProfile) {
                        msgObj.senderName = senderProfile.name || 'Friend';
                        msgObj.senderPP = senderProfile.profilePic || '/default-avatar.png';
                    } else {
                        msgObj.senderName = msgObj.senderName || 'Friend';
                        msgObj.senderPP = msgObj.senderPP || '/default-avatar.png';
                    }
                } catch (error) {
                    console.warn('Error fetching sender profile for message:', msg._id);
                    msgObj.senderName = msgObj.senderName || 'Friend';
                    msgObj.senderPP = msgObj.senderPP || '/default-avatar.png';
                }
                return msgObj;
            })
        );
        
        // Filter out invalid messages that are missing senderId or receiverId
        const validMessages = enrichedMessages.filter(msg => msg.senderId && msg.receiverId);
        
        if (enrichedMessages.length > validMessages.length) {
            console.warn(`Filtered ${enrichedMessages.length - validMessages.length} invalid messages (missing senderId/receiverId)`);
        }
        
        return res.status(200).json({
            messages: validMessages.reverse() // Reverse to show in chronological order
        });
        
    } catch (error) {
        console.error('Error fetching new messages:', error);
        return res.status(500).json({ messages: [] });
    }
};

// Count unseen new messages for sidebar/update checks
exports.getNewMessagesCount = async (req, res, next) => {
    try {
        const { profileId } = req.query;

        if (!profileId) {
            return res.status(400).json({ hasNewMessages: false, count: 0 });
        }

        const count = await Message.countDocuments({ receiverId: profileId, isSeen: false });
        return res.status(200).json({
            hasNewMessages: count > 0,
            count
        });
    } catch (error) {
        console.error('Error fetching new message count:', error);
        return res.status(500).json({ hasNewMessages: false, count: 0 });
    }
};

// HTTP-based message reactions checking
exports.getMessageReactions = async (req, res, next) => {
    try {
        const { messageId } = req.query;
        
        if (!messageId) {
            return res.status(400).json({ reactions: [] });
        }
        
        const message = await Message.findById(messageId);
        
        if (!message) {
            return res.status(404).json({ reactions: [] });
        }
        
        return res.status(200).json({
            reactions: message.reacts || []
        });
        
    } catch (error) {
        console.error('Error fetching message reactions:', error);
        return res.status(500).json({ reactions: [] });
    }
};

// HTTP-based mark message as seen
exports.markMessageAsSeen = async (req, res, next) => {
    try {
        const { messageId, messageIds } = req.body;
        
        console.log('📍 markMessageAsSeen - Body received:', { messageId, messageIds, body: req.body });
        
        // Support both single and multiple message IDs
        const ids = messageIds && Array.isArray(messageIds) ? messageIds : (messageId ? [messageId] : []);
        
        if (!ids || ids.length === 0) {
            console.warn('❌ No message IDs provided - messageId:', messageId, 'messageIds:', messageIds);
            return res.status(400).json({ message: 'Message ID(s) required', received: { messageId, messageIds } });
        }
        
        console.log('✅ Processing message IDs:', ids);
        
        // Update all messages as seen
        const result = await Message.updateMany(
            { _id: { $in: ids } },
            { isSeen: true },
            { new: true }
        );
        
        console.log('📝 Message update result:', { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
        
        if (result.modifiedCount > 0 || result.matchedCount > 0) {
            console.log('✅ Successfully updated messages as seen - emitting socket events');
            // Emit socket event to notify senders that messages were seen
            const io = req.app.get('io');
            if (io) {
                ids.forEach((id) => {
                    console.log('📡 Emitting messageSeen event for:', id);
                    io.emit('messageSeen', {
                        messageId: id,
                        seenBy: req.profile._id,
                        timestamp: new Date()
                    });
                });
            }
            
            return res.status(200).json({ 
                message: 'Messages marked as seen',
                updatedCount: result.modifiedCount,
                matchedCount: result.matchedCount
            });
        }
        
        console.warn('❌ Failed to update any messages:', { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, ids });
        return res.status(400).json({ message: 'Failed to mark messages as seen', matched: result.matchedCount, modified: result.modifiedCount });
        
    } catch (error) {
        console.error('❌ Error marking message as seen:', error);
        return res.status(500).json({ message: 'Internal server error', error: error.message });
    }
};

exports.deleteMessage = async (req, res, next) => {
    try {
        const { messageId } = req.body;
        
        if (!messageId) {
            return res.status(400).json({ message: 'Message ID is required' });
        }
        
        const message = await Message.findById(messageId);
        
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }
        
        // Message sender IDs are stored as strings, while req.profile._id is an ObjectId.
        // Normalize both sides before checking ownership.
        if (String(message.senderId) !== String(req.profile._id)) {
            return res.status(403).json({ message: 'You can only delete your own messages' });
        }
        
        // Delete the message
        await Message.findByIdAndDelete(messageId);
        
        // Emit real-time event to all users in the chat room
        const io = req.app.get('io');
        if (io && message.room) {
            io.to(message.room).emit('deleteMessage', messageId);
        }
        
        return res.status(200).json({ message: 'Message deleted successfully' });
    } catch (error) {
        console.error('Error deleting message:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

