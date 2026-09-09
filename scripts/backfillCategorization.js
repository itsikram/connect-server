const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Post = require('../models/Post');
const Watch = require('../models/Watch');
const { categorizeContent } = require('../services/aiCategorizationService');

const uri = process.env.NODE_ENV === 'production' ? process.env.PROD_MONGODB_URI : process.env.DEV_MONGODB_URI;
const batchSize = Math.max(Number(process.env.AI_BACKFILL_BATCH_SIZE || 25), 1);
const pauseMs = Math.max(Number(process.env.AI_BACKFILL_PAUSE_MS || 500), 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processModel = async (Model, kind) => {
    let processed = 0;
    const cursor = Model.find({ $or: [{ 'aiMetadata.status': { $exists: false } }, { 'aiMetadata.status': { $ne: 'ready' } }] }).sort({ _id: 1 }).cursor();
    let batch = [];
    for await (const item of cursor) {
        batch.push(item);
        if (batch.length < batchSize) continue;
        for (const content of batch) {
            const result = await categorizeContent({ content: content.toObject(), kind });
            await Model.updateOne({ _id: content._id }, { $set: { aiMetadata: result } });
            processed += 1;
            console.log(`[ai-backfill] ${kind}: ${processed}`);
            await sleep(pauseMs);
        }
        batch = [];
    }
    for (const content of batch) {
        const result = await categorizeContent({ content: content.toObject(), kind });
        await Model.updateOne({ _id: content._id }, { $set: { aiMetadata: result } });
        processed += 1;
        console.log(`[ai-backfill] ${kind}: ${processed}`);
        await sleep(pauseMs);
    }
    return processed;
};

(async () => {
    if (!uri) throw new Error('DEV_MONGODB_URI or PROD_MONGODB_URI is required');
    await mongoose.connect(uri);
    const posts = await processModel(Post, 'post');
    const watches = await processModel(Watch, 'watch');
    console.log(`[ai-backfill] complete: ${posts} posts, ${watches} watches`);
    await mongoose.disconnect();
})().catch(async (error) => {
    console.error('[ai-backfill] failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
});
