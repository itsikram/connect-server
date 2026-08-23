const mongoose = require('mongoose');
require('dotenv').config();

const Message = require('../models/Message');

const markAllMessagesSeen = async () => {
  try {
    const mongoUri = process.env.DEV_MONGODB_URI || process.env.PROD_MONGODB_URI;
    
    if (!mongoUri) {
      console.error('❌ No MongoDB URI configured');
      process.exit(1);
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    console.log('📝 Marking all messages as seen...');
    
    const result = await Message.updateMany(
      { isSeen: false },
      { $set: { isSeen: true } }
    );

    console.log('✅ Update complete!');
    console.log(`   Modified: ${result.modifiedCount} messages`);
    console.log(`   Matched: ${result.matchedCount} messages`);

    if (result.modifiedCount > 0) {
      console.log(`\n✨ All ${result.modifiedCount} unseen messages marked as seen`);
    } else {
      console.log('\nℹ️  No unseen messages found');
    }

    // Verify the update
    const unseenCount = await Message.countDocuments({ isSeen: false });
    const seenCount = await Message.countDocuments({ isSeen: true });
    
    console.log('\n📊 Message Status:');
    console.log(`   Seen: ${seenCount}`);
    console.log(`   Unseen: ${unseenCount}`);

    await mongoose.connection.close();
    console.log('\n✅ Done!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

markAllMessagesSeen();
