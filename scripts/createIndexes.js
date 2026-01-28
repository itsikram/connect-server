const mongoose = require('mongoose');

async function createIndexes() {
    try {
        const Message = mongoose.connection.db.collection('messages');
        const Profile = mongoose.connection.db.collection('profiles');

        console.log('Creating database indexes...');

        // Message collection indexes
        await Message.createIndex({ senderId: 1, receiverId: 1, timestamp: -1 });
        await Message.createIndex({ receiverId: 1, timestamp: -1 });
        await Message.createIndex({ senderId: 1, timestamp: -1 });
        await Message.createIndex({ timestamp: -1 });

        // Profile collection indexes
        await Profile.createIndex({ lastActive: -1 });
        await Profile.createIndex({ _id: 1 });

        console.log('Database indexes created successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Error creating indexes:', error);
        process.exit(1);
    }
}

// Connect to MongoDB and create indexes
const MONGODB_URI = process.env.PROD_MONGODB_URI || process.env.DEV_MONGODB_URI;

const fullUri = MONGODB_URI.endsWith('/') ? MONGODB_URI + 'connect' : MONGODB_URI;
console.log('Connecting to:', fullUri);
mongoose.connect(fullUri, {})
    .then(() => {
        console.log('Connected to MongoDB');
        createIndexes();
    })
    .catch(error => {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    });
