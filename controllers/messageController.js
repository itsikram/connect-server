const Message = require('../models/Message')
const Profile = require('../models/Profile')


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

    try{

    let profileId = req.query.profileId || req.profile._id

    let profileContacts = []
    let myProfile = await Profile.findOne({ _id: profileId }).populate('friends')

    if (!myProfile) return res.json({message: 'Profile Not Found'}).status(400)

    if (myProfile?.friends !== null) {
        for (const friendProfile of myProfile.friends) {
            const messages = await Message.find({
                senderId: friendProfile._id,
                receiverId: profileId
            }).limit(1).sort({ timestamp: -1 })

            profileContacts.push({ person: friendProfile, messages })
        }
        res.json(profileContacts).status(200)
    }else{
        res.json({message: 'No Friends Found'}).status(200)
    }
    }catch(error){
        next(error)
    }
}
exports.getChatHistory = async(req,res,next) => {
    try {
        let profileId = req.query.profileId || req.profile._id
        let friendId = req.query.friendId
        let limit = parseInt(req.query.limit) || 20
                
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
