const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.PROD_MONGODB_URI || process.env.DEV_MONGODB_URI;
const fullUri = MONGODB_URI.endsWith('/') ? MONGODB_URI + 'connect' : MONGODB_URI;

mongoose.connect(fullUri, {})
    .then(() => {
        console.log('Connected to MongoDB');
        testChatListPerformance();
    })
    .catch(error => {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    });

// Import the Message and Profile models
const Message = require('../models/Message');
const Profile = require('../models/Profile');

async function testChatListPerformance() {
    try {
        const profileId = '67e431d61e4463f7adfa544e'; // Test profile ID
        
        console.log('Testing optimized getChatList performance...');
        const startTime = Date.now();
        
        // Use the same aggregation pipeline as the optimized function
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
                $sort: { timestamp: -1 }
            },
            {
                $group: {
                    _id: '$otherUserId',
                    lastMessage: { $first: '$$ROOT' }
                }
            }
        ]);

        const endTime = Date.now();
        const duration = endTime - startTime;
        
        console.log(`✅ Optimized query completed in ${duration}ms`);
        console.log(`📊 Found ${lastMessages.length} conversations`);
        
        // Test the old approach for comparison
        console.log('\nTesting old approach for comparison...');
        const oldStartTime = Date.now();
        
        const myProfile = await Profile.findOne({ _id: profileId }).populate('friends');
        
        if (myProfile?.friends) {
            let messageCount = 0;
            for (const friendProfile of myProfile.friends.slice(0, 5)) { // Test first 5 friends
                const messages = await Message.find({
                    $or: [
                        { senderId: friendProfile._id, receiverId: profileId },
                        { senderId: profileId, receiverId: friendProfile._id }
                    ]
                }).limit(1).sort({ timestamp: -1 });
                messageCount += messages.length;
            }
            
            const oldEndTime = Date.now();
            const oldDuration = oldEndTime - oldStartTime;
            
            console.log(`⏱️  Old approach (5 friends) completed in ${oldDuration}ms`);
            console.log(`📈 Performance improvement: ${Math.round((oldDuration - duration) / oldDuration * 100)}% faster`);
        }
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}
