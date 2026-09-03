const Message = require('../models/Message')
const Profile = require('../models/Profile')
const { sendChatMessageDataPush } = require('../utils/pushNotifications')
const { listHasId } = require('../utils/ids')


const reactionProfileId = (reaction) => String(reaction && reaction.profile ? reaction.profile : reaction || '');
const normalizedReactions = (reactions = []) => {
    const seen = new Set();
    return (Array.isArray(reactions) ? reactions : []).reduce((result, reaction) => {
        const profile = reaction && reaction.profile ? reaction.profile : reaction;
        const id = reactionProfileId(reaction);
        if (!id || seen.has(id)) return result;
        seen.add(id);
        result.push({ profile, type: reaction && reaction.type ? reaction.type : '👍' });
        return result;
    }, []);
};

const canAccessMessage = (message, profileId) =>
    message && [String(message.senderId), String(message.receiverId)].includes(String(profileId));

const emitReactionUpdate = (io, message) => {
    if (!io || !message) return;
    const payload = { message: message.toObject ? message.toObject() : message, reactions: normalizedReactions(message.reacts) };
    io.to(message.room).emit('messageReactionUpdated', payload);
    io.to(String(message.senderId)).emit('messageReactionUpdated', payload);
    io.to(String(message.receiverId)).emit('messageReactionUpdated', payload);
};

exports.removeMessageReact = async (req, res, next) => {
    try {
        const profileId = req.profile && req.profile._id;
        const { messageId } = req.body;
        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (!canAccessMessage(message, profileId)) return res.status(403).json({ message: 'Message access denied' });
        message.reacts = normalizedReactions(message.reacts).filter((reaction) => String(reaction.profile) !== String(profileId));
        await message.save();
        emitReactionUpdate(req.app.get('io'), message);
        return res.status(200).json({ message: 'Message React Removed', updatedMessage: message, reactions: message.reacts });
    } catch (error) { next(error); }
}
exports.addMessageReact = async (req, res, next) => {

    try {
        const profileId = req.profile && req.profile._id;
        const { messageId, reactType = '👍' } = req.body;
        if (!reactType || typeof reactType !== 'string') return res.status(400).json({ message: 'Invalid reaction type' });
        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (!canAccessMessage(message, profileId)) return res.status(403).json({ message: 'Message access denied' });
        message.reacts = normalizedReactions(message.reacts).filter((reaction) => String(reaction.profile) !== String(profileId));
        message.reacts.push({ profile: profileId, type: reactType });
        await message.save();
        emitReactionUpdate(req.app.get('io'), message);
        return res.status(200).json({ message: 'Message React Added', updatedMessage: message, reactions: message.reacts });

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
        })
            .select('attachment timestamp')
            .sort({ timestamp: -1 })
            .limit(10)
            .lean();

        res.json(getMessages).status(200)
        
    } catch (error) {
        next(error)
        
    }
}

exports.getChatList = async(req,res,next) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            timedOut = true;
            res.status(408).json({ message: 'Request timeout' });
        }
    }, 8000); // 8 second timeout

    try {
        let profileId = req.query.profileId || req.profile._id;
        const now = new Date();

        // Use two indexed scans instead of a single $or (which cannot use both indexes)
        const profileIdStr = String(profileId);
        const [sentAgg, receivedAgg] = await Promise.all([
            Message.aggregate([
                { $match: { senderId: profileIdStr } },
                { $sort: { timestamp: -1 } },
                { $group: { _id: '$receiverId', lastMessage: { $first: '$$ROOT' } } },
            ]).option({ maxTimeMS: 7500 }),
            Message.aggregate([
                { $match: { receiverId: profileIdStr } },
                { $sort: { timestamp: -1 } },
                { $group: { _id: '$senderId', lastMessage: { $first: '$$ROOT' } } },
            ]).option({ maxTimeMS: 7500 }),
        ]);

        if (timedOut || res.headersSent) return;

        const lastMessagesByPeer = new Map();
        const consider = (otherId, msg) => {
            if (otherId == null || !msg) return;
            const key = String(otherId);
            const existing = lastMessagesByPeer.get(key);
            if (!existing || new Date(msg.timestamp) > new Date(existing.timestamp)) {
                lastMessagesByPeer.set(key, msg);
            }
        };
        sentAgg.forEach((row) => consider(row._id, row.lastMessage));
        receivedAgg.forEach((row) => consider(row._id, row.lastMessage));

        // Get profile with slim friend fields (avoid shipping tokens, push subs, nested friends)
        const myProfile = await Profile.findOne({ _id: profileId })
            .select('_id friends')
            .populate({
                path: 'friends',
                select: '_id fullName displayName username nickname profilePic isActive lastActive user',
                populate: { path: 'user', select: 'firstName surname' },
            });

        if (timedOut || res.headersSent) return;
        
        if (!myProfile) {
            clearTimeout(timeout);
            return res.status(400).json({ message: 'Profile Not Found' });
        }

        if (myProfile?.friends == null || myProfile.friends.length === 0) {
            clearTimeout(timeout);
            return res.status(200).json({ message: 'No Friends Found' });
        }

        // Create a map for quick lookup of last messages
        const messageMap = lastMessagesByPeer;

        // Build profile contacts array
        const profileContacts = myProfile.friends.map(friendProfile => {
            const lastActive = friendProfile.lastActive ? new Date(friendProfile.lastActive) : null;
            const isOnline = Boolean(friendProfile.isActive) ||
                (lastActive && (now - lastActive) < 5 * 60 * 1000);
            
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
        if (timedOut || res.headersSent) return;
        return next(error);
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

        // Fetch one extra row instead of a separate countDocuments query
        const messages = await Message.find(query)
            .select('-unseenReminderEmailSentAt -unseenReminderEmailProcessingKey -unseenReminderEmailProcessingAt -unseenReminderEmailLastError')
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(limit + 1)
            .populate({
                path: 'parent',
                select: 'message senderId attachment timestamp messageType',
            })
            .lean();

        const hasMore = messages.length > limit;
        const pageMessages = hasMore ? messages.slice(0, limit) : messages;

        // Return messages in chronological order (oldest first)
        res.status(200).json({
            messages: pageMessages.reverse(),
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

        const messages = await Message.find(query)
            .select('-unseenReminderEmailSentAt -unseenReminderEmailProcessingKey -unseenReminderEmailProcessingAt -unseenReminderEmailLastError')
            .sort({ timestamp: -1 })
            .limit(limit + 1)
            .populate({
                path: 'parent',
                select: 'message senderId attachment timestamp messageType',
            })
            .lean();

        const hasMore = messages.length > limit;
        const resultMessages = messages.slice(0, limit);

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
        const { room, senderId: bodySenderId, receiverId, message, attachment, parent, isAi = false, messageType = 'text', callType, callEvent, tempId } = req.body;
        const senderId = bodySenderId || req.profile?._id;

        // Prevent messaging if either user has blocked the other
        if (senderId && receiverId && String(senderId) !== String(receiverId)) {
            const [senderProfile, receiverProfile] = await Promise.all([
                Profile.findById(senderId).select('blockedUsers'),
                Profile.findById(receiverId).select('blockedUsers'),
            ]);

            const senderBlockedReceiver = listHasId(senderProfile?.blockedUsers, receiverId);
            const receiverBlockedSender = listHasId(receiverProfile?.blockedUsers, senderId);

            if (senderBlockedReceiver || receiverBlockedSender) {
                return res.status(403).json({
                    message: 'Message blocked',
                    reason: senderBlockedReceiver ? 'You blocked this user' : 'You are blocked by this user'
                });
            }
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
        await Profile.findByIdAndUpdate(userId, { lastActive: new Date(), isActive: true });
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
        
        const newMessages = await Message.find(query)
            .select('-unseenReminderEmailSentAt -unseenReminderEmailProcessingKey -unseenReminderEmailProcessingAt -unseenReminderEmailLastError')
            .sort({ timestamp: -1 })
            .limit(20)
            .populate({
                path: 'parent',
                select: 'message senderId attachment timestamp messageType',
            })
            .lean();

        const senderIds = [
            ...new Set(
                newMessages
                    .map((msg) => (msg.senderId ? String(msg.senderId) : ''))
                    .filter(Boolean),
            ),
        ];
        const senders =
            senderIds.length > 0
                ? await Profile.find({ _id: { $in: senderIds } })
                      .select('name profilePic')
                      .lean()
                : [];
        const senderMap = new Map(
            senders.map((profile) => [String(profile._id), profile]),
        );

        const enrichedMessages = newMessages.map((msg) => {
            const senderProfile = senderMap.get(String(msg.senderId));
            return {
                ...msg,
                senderName: senderProfile?.name || msg.senderName || 'Friend',
                senderPP:
                    senderProfile?.profilePic ||
                    msg.senderPP ||
                    '/default-avatar.png',
            };
        });
        
        const validMessages = enrichedMessages.filter(msg => msg.senderId && msg.receiverId);
        
        return res.status(200).json({
            messages: validMessages.reverse()
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
        if (!canAccessMessage(message, req.profile && req.profile._id)) {
            return res.status(403).json({ reactions: [] });
        }
        
        return res.status(200).json({
            reactions: normalizedReactions(message.reacts)
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
        const ids = messageIds && Array.isArray(messageIds) ? messageIds : (messageId ? [messageId] : []);
        
        if (!ids || ids.length === 0) {
            return res.status(400).json({ message: 'Message ID(s) required' });
        }

        const result = await Message.updateMany(
            { _id: { $in: ids }, isSeen: { $ne: true } },
            { $set: { isSeen: true } }
        );

        if (result.modifiedCount > 0) {
            const io = req.app.get('io');
            if (io) {
                ids.forEach((id) => {
                    io.emit('messageSeen', {
                        messageId: id,
                        seenBy: req.profile._id,
                        timestamp: new Date()
                    });
                });
            }
        }

        return res.status(200).json({ 
            message: 'Messages marked as seen',
            updatedCount: result.modifiedCount,
            matchedCount: result.matchedCount
        });
        
    } catch (error) {
        console.error('Error marking message as seen:', error);
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

exports.deleteConversation = async (req, res, next) => {
    try {
        const profileId = String(req.profile?._id || '');
        const friendId = req.body?.friendId;

        if (!profileId || !friendId) {
            return res.status(400).json({ message: 'Profile ID and friend ID are required' });
        }

        const conversationQuery = {
            $or: [
                { senderId: profileId, receiverId: String(friendId) },
                { senderId: String(friendId), receiverId: profileId },
            ],
        };

        const result = await Message.deleteMany(conversationQuery);

        const io = req.app.get('io');
        if (io) {
            io.to(profileId).emit('conversationDeleted', {
                profileId,
                friendId: String(friendId),
                deletedCount: result.deletedCount || 0,
            });
            io.to(String(friendId)).emit('conversationDeleted', {
                profileId: String(friendId),
                friendId: profileId,
                deletedCount: result.deletedCount || 0,
            });
        }

        return res.status(200).json({
            message: 'Conversation deleted successfully',
            deletedCount: result.deletedCount || 0,
        });
    } catch (error) {
        console.error('Error deleting conversation:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.sendBump = async (req, res, next) => {
    try {
        const io = req.app.get('io');
        const friendProfile = req.body?.friendProfile;
        const myProfile = req.body?.myProfile || req.profile?._id;
        const result = await require('../utils/sendBump').sendBump(io, {
            friendProfile,
            myProfile,
        });
        if (!result.ok) {
            return res.status(400).json({ message: 'Bump failed', reason: result.reason });
        }
        return res.status(200).json({ message: 'Bump sent', skipped: !!result.skipped });
    } catch (error) {
        next(error);
    }
};
