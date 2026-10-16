const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { prisma } = require('../utils/db');

const markAllMessagesSeen = async () => {
  try {
    if (!process.env.DATABASE_URL) {
      console.error('❌ No database configured (set DB_HOST, DB_NAME, DB_USER, DB_PASSWORD)');
      process.exit(1);
    }

    console.log('📝 Marking all messages as seen...');

    const result = await prisma.message.updateMany({
      where: { isSeen: false },
      data: { isSeen: true },
    });

    console.log('✅ Update complete!');
    console.log(`   Modified: ${result.count} messages`);

    if (result.count > 0) {
      console.log(`\n✨ All ${result.count} unseen messages marked as seen`);
    } else {
      console.log('\nℹ️  No unseen messages found');
    }

    // Verify the update
    const unseenCount = await prisma.message.count({ where: { isSeen: false } });
    const seenCount = await prisma.message.count({ where: { isSeen: true } });

    console.log('\n📊 Message Status:');
    console.log(`   Seen: ${seenCount}`);
    console.log(`   Unseen: ${unseenCount}`);

    await prisma.$disconnect();
    console.log('\n✅ Done!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

markAllMessagesSeen();
