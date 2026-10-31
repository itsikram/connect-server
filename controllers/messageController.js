const { prisma, isValidId: isValidObjectId, populated } = require('../utils/db')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')
const { notifyNewChatMessage } = require('../utils/chatNotifications')
const { senderDisplayName } = require('../utils/messagePreview')
const presence = require('../sockets/presence')
const {
    isSecureRequest,
    prepareSecureContent,
    createSecureMessage,
    withSecureState,
    openSecureMessage,
    deleteSecureContent,
} = require('../utils/secureMessages')
const config = require('../config/config.json')

// Reminder bookkeeping columns never leave the server (was .select('-unseenReminder...')).
const REMINDER_OMIT = {
    unseenReminderEmailSentAt: true,
    unseenReminderEmailProcessingKey: true,
    unseenReminderEmailProcessingAt: true,
    unseenReminderEmailLastError: true,
};
const PARENT_SELECT = { id: true, _id: true, message: true, senderId: true, attachment: true, timestamp: true, messageType: true };
const conversationWhere = (a, b) => ({
    OR: [
        { senderId: String(a), receiverId: String(b) },
        { senderId: String(b), receiverId: String(a) },
    ],
});
const findMessage = async (id) =>
    (isValidObjectId(id) ? prisma.message.findUnique({ where: { id: String(id) } }) : null);
const findMessageWithParent = async (where) =>
    populated(await prisma.message.findFirst({ where, include: { parentDoc: true } }), 'parent');

// The signed-in profile is always one side of a conversation. `profileId`
// query params are ignored: trusting them let any user read anyone's chats.
const viewerId = (req) => String(req.profile?._id || '');
const clampLimit = (value, fallback = 20) => {
    const limit = parseInt(value, 10);
    if (!Number.isFinite(limit) || limit < 1) return fallback;
    return Math.min(limit, 100);
};


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
        const message = await findMessage(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (!canAccessMessage(message, profileId)) return res.status(403).json({ message: 'Message access denied' });
        message.reacts = normalizedReactions(message.reacts).filter((reaction) => String(reaction.profile) !== String(profileId));
        await prisma.message.update({ where: { id: message.id }, data: { reacts: message.reacts } });
        emitReactionUpdate(req.app.get('io'), message);
        return res.status(200).json({ message: 'Message React Removed', updatedMessage: message, reactions: message.reacts });
    } catch (error) { next(error); }
}
exports.addMessageReact = async (req, res, next) => {

    try {
        const profileId = req.profile && req.profile._id;
        const { messageId, reactType = '👍' } = req.body;
        if (!reactType || typeof reactType !== 'string') return res.status(400).json({ message: 'Invalid reaction type' });
        const message = await findMessage(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (!canAccessMessage(message, profileId)) return res.status(403).json({ message: 'Message access denied' });
        message.reacts = normalizedReactions(message.reacts).filter((reaction) => String(reaction.profile) !== String(profileId));
        message.reacts.push({ profile: String(profileId), type: reactType });
        await prisma.message.update({ where: { id: message.id }, data: { reacts: message.reacts } });
        emitReactionUpdate(req.app.get('io'), message);
        return res.status(200).json({ message: 'Message React Added', updatedMessage: message, reactions: message.reacts });

    } catch (error) {
        next(error)
    }

}

exports.getMedia = async(req,res,next) => {

    try {
        const fileUrlRegex = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
        if (!isValidObjectId(req.query.profileId)) return res.status(200).json([]);
        const candidates = await prisma.message.findMany({
            where: { ...conversationWhere(viewerId(req), req.query.profileId), attachment: { startsWith: 'http' } },
            select: { id: true, _id: true, attachment: true, timestamp: true },
            orderBy: { timestamp: 'desc' },
            take: 50,
        });
        let getMessages = candidates.filter((m) => fileUrlRegex.test(m.attachment || '')).slice(0, 10);

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
        const profileId = viewerId(req);

        // Use two indexed scans instead of a single $or (which cannot use both indexes)
        const profileIdStr = String(profileId);
        // Latest message id per peer, one indexed scan per direction.
        const [sentIds, receivedIds] = await Promise.all([
            prisma.$queryRaw`SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY receiverId ORDER BY timestamp DESC) AS rn FROM messages WHERE senderId = ${profileIdStr}) t WHERE rn = 1`,
            prisma.$queryRaw`SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY senderId ORDER BY timestamp DESC) AS rn FROM messages WHERE receiverId = ${profileIdStr}) t WHERE rn = 1`,
        ]);
        const latestIds = [...sentIds, ...receivedIds].map((row) => row.id);
        const latestMessages = latestIds.length
            ? await withSecureState(await prisma.message.findMany({ where: { id: { in: latestIds } }, omit: REMINDER_OMIT }))
            : [];
        const sentAgg = [];
        const receivedAgg = [];
        latestMessages.forEach((m) => {
            if (m.senderId === profileIdStr) sentAgg.push({ _id: m.receiverId, lastMessage: m });
            if (m.receiverId === profileIdStr) receivedAgg.push({ _id: m.senderId, lastMessage: m });
        });

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

        // Get profile with slim connect fields (avoid shipping tokens, push subs, nested connects)
        const myProfileRow = await prisma.profile.findUnique({
            where: { id: profileIdStr },
            select: {
                id: true,
                _id: true,
                connects: {
                    select: {
                        connectDoc: {
                            select: {
                                id: true, _id: true, fullName: true, displayName: true, username: true, nickname: true,
                                profilePic: true, isActive: true, lastActive: true, user: true,
                                userDoc: { select: { id: true, _id: true, firstName: true, surname: true } },
                            },
                        },
                    },
                },
            },
        });
        const myProfile = myProfileRow && {
            _id: myProfileRow._id,
            connects: myProfileRow.connects
                .map((c) => c.connectDoc)
                .filter(Boolean)
                .map((p) => populated(p, 'user')),
        };

        if (timedOut || res.headersSent) return;
        
        if (!myProfile) {
            clearTimeout(timeout);
            return res.status(400).json({ message: 'Profile Not Found' });
        }

        if (myProfile?.connects == null || myProfile.connects.length === 0) {
            clearTimeout(timeout);
            return res.status(200).json({ message: 'No Connects Found' });
        }

        // Create a map for quick lookup of last messages
        const messageMap = lastMessagesByPeer;

        // Build profile contacts array
        const profileContacts = myProfile.connects.map(connectProfile => {
            const lastActive = connectProfile.lastActive ? new Date(connectProfile.lastActive) : null;
            const status = presence.statusFromProfile(connectProfile);
            const isOnline = status.isActive;

            return {
                person: { ...connectProfile, isActive: isOnline },
                messages: messageMap.get(connectProfile._id.toString()) ? [messageMap.get(connectProfile._id.toString())] : [],
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
        const profileId = viewerId(req)
        const connectId = req.query.connectId
        const limit = clampLimit(req.query.limit)
        const skip = Math.max(0, parseInt(req.query.skip, 10) || 0)

        if (!profileId || !isValidObjectId(connectId)) {
            return res.status(400).json({ messages: [], hasMore: false, error: 'connectId is required' });
        }

        // Fetch one extra row instead of a separate count query
        const messages = populated(await prisma.message.findMany({
            where: conversationWhere(profileId, connectId),
            omit: REMINDER_OMIT,
            orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
            skip,
            take: limit + 1,
            include: { parentDoc: { select: PARENT_SELECT } },
        }), 'parent');

        const hasMore = messages.length > limit;
        const pageMessages = hasMore ? messages.slice(0, limit) : messages;
        await withSecureState(pageMessages);

        // Chat history is private and changes constantly; never let a browser,
        // proxy or service worker reuse an old copy.
        res.set('Cache-Control', 'no-store');
        // Return messages in chronological order (oldest first)
        res.status(200).json({
            messages: pageMessages.reverse(),
            hasMore
        });

    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ messages: [], hasMore: false, error: 'Could not load messages' });
    }
}

exports.getOldMessages = async(req,res,next) => {
    try {
        const profileId = viewerId(req)
        const connectId = req.query.connectId
        const limit = clampLimit(req.query.limit)
        const beforeTimestamp = req.query.beforeTimestamp

        // Validate required parameters
        if (!isValidObjectId(connectId)) {
            return res.status(400).json({ 
                messages: [], 
                hasMore: false,
                error: 'connectId is required'
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
        
// Build query for messages between these users before the given timestamp
        const query = { ...conversationWhere(profileId, connectId), timestamp: { lt: timestamp } };

        const messages = populated(await prisma.message.findMany({
            where: query,
            omit: REMINDER_OMIT,
            orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            include: { parentDoc: { select: PARENT_SELECT } },
        }), 'parent');

        const hasMore = messages.length > limit;
        const resultMessages = messages.slice(0, limit);
        await withSecureState(resultMessages);

        res.set('Cache-Control', 'no-store');
        res.status(200).json({
            messages: resultMessages.reverse(),
            hasMore
        });
        
    } catch (error) {
        console.error('Error fetching old messages:', error);
        res.status(500).json({
            messages: [],
            hasMore: false,
            error: 'Could not load messages'
        });
    }
}




// Generate a unique room ID using user IDs

// HTTP-based message sending
exports.sendMessage = async (req, res, next) => {
    try {
        const io = req.app.get('io');
        const { receiverId, message, attachment, parent, messageType = 'text', callType, callEvent, tempId } = req.body;
        const secure = isSecureRequest(req.body);
        // Authenticated identity is the sender; the body value is a legacy fallback only.
        const senderId = String(req.profile?._id || req.body.senderId || '');
        if (!senderId || !isValidObjectId(receiverId)) {
            return res.status(400).json({ message: 'senderId and receiverId are required' });
        }
        let secureContent = null;
        if (secure) {
            const prepared = prepareSecureContent({ message, attachment, messageType });
            if (!prepared.ok) return res.status(400).json({ message: prepared.error });
            secureContent = prepared.content;
        }
        // Same canonical room the socket path and both clients use.
        const room = [senderId, String(receiverId)].sort().join('_');

        // Idempotent retries: return the existing copy of this optimistic message.
        if (tempId) {
            const existing = await findMessageWithParent({ senderId, tempId: String(tempId) });
            if (existing) {
                await withSecureState(existing);
                return res.status(200).json({ message: 'Message sent successfully', data: existing, duplicate: true });
            }
        }

        // Prevent messaging if either user has blocked the other
        if (senderId && receiverId && String(senderId) !== String(receiverId)) {
            const blocks = await prisma.block.findMany({
                where: {
                    OR: [
                        { profile: senderId, blocked: String(receiverId) },
                        { profile: String(receiverId), blocked: senderId },
                    ],
                },
                select: { profile: true },
            });

            const senderBlockedReceiver = blocks.some((b) => b.profile === senderId);
            const receiverBlockedSender = blocks.some((b) => b.profile === String(receiverId));

            if (senderBlockedReceiver || receiverBlockedSender) {
                return res.status(403).json({
                    message: 'Message blocked',
                    reason: senderBlockedReceiver ? 'You blocked this user' : 'You are blocked by this user'
                });
            }
        }

        const newMessage = secureContent
            ? await createSecureMessage({ room, senderId, receiverId, parent, tempId, content: secureContent })
            : await prisma.message.create({
                data: {
                    room,
                    senderId,
                    receiverId: String(receiverId),
                    message: message == null ? undefined : String(message),
                    attachment: attachment || undefined,
                    ...(parent && isValidObjectId(parent) ? { parent: String(parent) } : {}),
                    messageType,
                    callType,
                    callEvent,
                    tempId: tempId == null ? undefined : String(tempId),
                    reacts: [],
                },
            });

        // Update last active time for sending message
        await updateLastActive(senderId);

        let updatedMessage = await withSecureState(await findMessageWithParent({ id: newMessage.id }));
        let profileData = populated(
            await prisma.profile.findUnique({ where: { id: senderId }, include: { userDoc: true } }),
            'user',
        );
        
        if (!profileData) {
            return res.status(404).json({ message: 'Sender profile not found' });
        }
        
        const senderName = senderDisplayName(profileData);
        let senderPP = profileData.profilePic || config.defaultProfile;
        
        // Emit via socket for real-time updates (same events as the socket send path)
        const messagePayload = { updatedMessage, senderName, senderPP, chatPage: true, isRealTime: true, tempId };
        io.to(room).emit('newMessage', messagePayload);
        io.to(senderId).emit('messageSent', messagePayload);

        const connectProfile = profileData;
        io.to(String(receiverId)).emit('newMessageToUser', { updatedMessage, senderName, senderPP, chatPage: false, connectProfile, isRealTime: true });

        // Same mobile + web notification fan-out as the socket path
        await notifyNewChatMessage(io, {
            updatedMessage,
            senderId,
            receiverId,
            senderName,
            senderPP,
            senderProfile: profileData,
            room,
        });

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
        await prisma.profile.updateMany({ where: { id: String(userId) }, data: { lastActive: new Date() } });
    } catch (error) {
        console.error('Error updating last active time:', error);
    }
};

// HTTP-based new messages polling
exports.getNewMessages = async (req, res, next) => {
    try {
        const { connectId, lastMessageId } = req.query;
        const profileId = viewerId(req);

        if (!profileId) {
            return res.status(400).json({ messages: [] });
        }

        let query;
        
        if (connectId && isValidObjectId(connectId)) {
            // Get messages between two specific users (for Chat.js)
            query = conversationWhere(profileId, connectId);
            
            // If we have a lastMessageId, only get messages newer than that
            if (lastMessageId) {
                const lastMessage = await findMessage(lastMessageId);
                if (lastMessage) {
                    query.timestamp = { gt: lastMessage.timestamp };
                }
            }
        } else {
            // Get all new messages for the user (for Main.js)
            query = {
                receiverId: String(profileId),
                isSeen: false
            };
            
            // If we have a lastMessageId, only get messages newer than that
            if (lastMessageId) {
                const lastMessage = await findMessage(lastMessageId);
                if (lastMessage) {
                    query.timestamp = { gt: lastMessage.timestamp };
                }
            }
        }
        
        const newMessages = populated(await prisma.message.findMany({
            where: query,
            omit: REMINDER_OMIT,
            orderBy: { timestamp: 'desc' },
            take: 20,
            include: { parentDoc: { select: PARENT_SELECT } },
        }), 'parent');
        await withSecureState(newMessages);

        const senderIds = [
            ...new Set(
                newMessages
                    .map((msg) => (msg.senderId ? String(msg.senderId) : ''))
                    .filter(Boolean),
            ),
        ];
        const senders =
            senderIds.length > 0
                ? await prisma.profile.findMany({
                      where: { id: { in: senderIds } },
                      select: { id: true, _id: true, profilePic: true },
                  })
                : [];
        const senderMap = new Map(
            senders.map((profile) => [String(profile._id), profile]),
        );

        const enrichedMessages = newMessages.map((msg) => {
            const senderProfile = senderMap.get(String(msg.senderId));
            return {
                ...msg,
                senderName: senderProfile?.name || msg.senderName || 'Connect',
                senderPP:
                    senderProfile?.profilePic ||
                    msg.senderPP ||
                    config.defaultProfile,
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
        const profileId = viewerId(req);

        if (!profileId) {
            return res.status(400).json({ hasNewMessages: false, count: 0 });
        }

        const count = await prisma.message.count({ where: { receiverId: String(profileId), isSeen: false } });
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
        
        const message = await findMessage(messageId);
        
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

        const myId = String(req.profile._id);
        const validIds = ids.map(String).filter((id) => isValidObjectId(id));
        // Only the receiver can mark a message as seen.
        const seenFilter = { id: { in: validIds }, receiverId: myId, isSeen: false };
        const toUpdate = await prisma.message.findMany({
            where: seenFilter,
            select: { id: true, _id: true, room: true, senderId: true, receiverId: true, timestamp: true },
        });
        let result = { modifiedCount: 0, matchedCount: 0 };
        if (toUpdate.length > 0) {
            const { count } = await prisma.message.updateMany({
                where: { id: { in: toUpdate.map((m) => m.id) }, isSeen: false },
                data: { isSeen: true },
            });
            result = { modifiedCount: count, matchedCount: toUpdate.length };
        }

        if (result.modifiedCount > 0) {
            const io = req.app.get('io');
            if (io) {
                // Deliver only to the two participants (all their devices),
                // never broadcast to every connected client.
                toUpdate.forEach((m) => {
                    io.to([m.room, String(m.senderId), String(m.receiverId)].filter(Boolean)).emit('messageSeen', {
                        messageId: String(m._id),
                        _id: String(m._id),
                        room: m.room,
                        senderId: String(m.senderId),
                        receiverId: String(m.receiverId),
                        messageTimestamp: m.timestamp,
                        seenBy: myId,
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
        
        const message = await findMessage(messageId);
        
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }
        
        // Message sender IDs are stored as strings, while req.profile._id is an ObjectId.
        // Normalize both sides before checking ownership.
        if (String(message.senderId) !== String(req.profile._id)) {
            return res.status(403).json({ message: 'You can only delete your own messages' });
        }
        
        // Delete the message
        await prisma.message.deleteMany({ where: { id: message.id } });
        await deleteCloudinaryResources([message.attachment]);
        await deleteSecureContent([message.id]);
        
        // Emit real-time event to all users in the chat room
        const io = req.app.get('io');
        if (io) {
            // Room + both participants so the other side's chat list and any
            // device without the chat open also drop the message.
            io.to([message.room, String(message.senderId), String(message.receiverId)].filter(Boolean))
                .emit('deleteMessage', String(messageId));
        }
        
        return res.status(200).json({ message: 'Message deleted successfully' });
    } catch (error) {
        console.error('Error deleting message:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Same rules as canEditMessage on the clients: my own plain text messages.
exports.editMessage = async (req, res, next) => {
    try {
        const { messageId } = req.body;
        const text = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

        if (!messageId) {
            return res.status(400).json({ message: 'Message ID is required' });
        }
        if (!text) {
            return res.status(400).json({ message: 'Message text is required' });
        }

        const message = await findMessage(messageId);
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }
        if (String(message.senderId) !== viewerId(req)) {
            return res.status(403).json({ message: 'You can only edit your own messages' });
        }
        if ((message.messageType || 'text') !== 'text' || !String(message.message || '').trim()) {
            return res.status(400).json({ message: 'Only text messages can be edited' });
        }

        const unchanged = text === String(message.message || '').trim();
        if (!unchanged) {
            await prisma.message.update({
                where: { id: message.id },
                data: { message: text, isEdited: true, editedAt: new Date() },
            });
        }
        const updatedMessage = await findMessageWithParent({ id: message.id });

        const io = req.app.get('io');
        if (io && !unchanged) {
            // Room + both participants: open chats, chat-list previews and
            // every other device of either side.
            io.to([message.room, String(message.senderId), String(message.receiverId)].filter(Boolean))
                .emit('messageEdited', {
                    messageId: String(message.id),
                    _id: String(message.id),
                    room: message.room,
                    senderId: String(message.senderId),
                    receiverId: String(message.receiverId),
                    message: updatedMessage.message,
                    isEdited: Boolean(updatedMessage.isEdited),
                    editedAt: updatedMessage.editedAt,
                });
        }

        return res.status(200).json({ message: 'Message edited successfully', data: updatedMessage });
    } catch (error) {
        console.error('Error editing message:', error);
        next(error);
    }
};

exports.deleteConversation = async (req, res, next) => {
    try {
        const profileId = String(req.profile?._id || '');
        const connectId = req.body?.connectId;

        if (!profileId || !connectId) {
            return res.status(400).json({ message: 'Profile ID and connect ID are required' });
        }

        const conversationQuery = conversationWhere(profileId, connectId);

        const messages = await prisma.message.findMany({ where: conversationQuery, select: { id: true, attachment: true, messageType: true } });
        const deleted = await prisma.message.deleteMany({ where: conversationQuery });
        const result = { deletedCount: deleted.count };
        await deleteCloudinaryResources(messages.map((message) => message.attachment));
        await deleteSecureContent(messages.filter((message) => message.messageType === 'secure').map((message) => message.id));

        const io = req.app.get('io');
        if (io) {
            io.to(profileId).emit('conversationDeleted', {
                profileId,
                connectId: String(connectId),
                deletedCount: result.deletedCount || 0,
            });
            io.to(String(connectId)).emit('conversationDeleted', {
                profileId: String(connectId),
                connectId: profileId,
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
        const connectProfile = req.body?.connectProfile;
        // A bump always comes from the signed-in profile.
        const myProfile = req.profile?._id;
        const result = await require('../utils/sendBump').sendBump(io, {
            connectProfile,
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

// One-time read of a vanishing secure message by its receiver.
exports.openSecureMessage = async (req, res, next) => {
    try {
        const result = await openSecureMessage({ messageId: req.body?.messageId, profileId: viewerId(req) });
        res.set('Cache-Control', 'no-store');
        if (!result.ok) {
            return res.status(result.status || 400).json({ message: result.error, state: result.state || null });
        }

        const { message, openedAt } = result;
        const io = req.app.get('io');
        if (io) {
            // Both participants on every device: the sender sees "Opened",
            // the receiver's other devices lock the bubble.
            io.to([message.room, String(message.senderId), String(message.receiverId)].filter(Boolean))
                .emit('secureMessageOpened', {
                    messageId: String(message.id),
                    _id: String(message.id),
                    room: message.room,
                    senderId: String(message.senderId),
                    receiverId: String(message.receiverId),
                    openedAt,
                });
        }

        return res.status(200).json({
            messageId: String(message.id),
            openedAt,
            content: result.content,
        });
    } catch (error) {
        next(error);
    }
};
