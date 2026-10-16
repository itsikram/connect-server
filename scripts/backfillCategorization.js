const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { prisma } = require('../utils/db');
const { withAiMetadata, aiMetadataData } = require('../services/contentShape');
const { categorizeContent } = require('../services/aiCategorizationService');

const batchSize = Math.max(Number(process.env.AI_BACKFILL_BATCH_SIZE || 25), 1);
const pauseMs = Math.max(Number(process.env.AI_BACKFILL_PAUSE_MS || 500), 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processModel = async (delegate, kind) => {
    let processed = 0;
    let cursor = null;
    for (;;) {
        // Everything not yet categorized, in id order, one batch at a time.
        const batch = await delegate.findMany({
            where: { aiStatus: { not: 'ready' } },
            orderBy: { id: 'asc' },
            take: batchSize,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const content of batch) {
            const result = await categorizeContent({ content: withAiMetadata({ ...content }), kind });
            await delegate.update({ where: { id: content.id }, data: aiMetadataData(result) });
            processed += 1;
            console.log(`[ai-backfill] ${kind}: ${processed}`);
            await sleep(pauseMs);
        }
        if (batch.length < batchSize) break;
        cursor = batch[batch.length - 1].id;
    }
    return processed;
};

(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const posts = await processModel(prisma.post, 'post');
    const watches = await processModel(prisma.watch, 'watch');
    console.log(`[ai-backfill] complete: ${posts} posts, ${watches} watches`);
    await prisma.$disconnect();
})().catch(async (error) => {
    console.error('[ai-backfill] failed:', error);
    await prisma.$disconnect().catch(() => {});
    process.exitCode = 1;
});
