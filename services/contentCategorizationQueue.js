const Post = require('../models/Post');
const Watch = require('../models/Watch');
const { categorizeContent, contentText, contentHash, mediaUrlFor } = require('./aiCategorizationService');
const { updateInterestProfile } = require('./recommendationService');

const queue = [];
let running = false;
const queuedKeys = new Set();

const processNext = async () => {
    if (running || queue.length === 0) return;
    running = true;
    const job = queue.shift();
    queuedKeys.delete(`${job.kind}:${job.id}`);
    try {
        const Model = job.kind === 'watch' ? Watch : Post;
        await Model.findByIdAndUpdate(job.id, {
            $set: { 'aiMetadata.status': 'pending', 'aiMetadata.error': undefined }
        });
        const content = await Model.findById(job.id).lean();
        if (content) {
            const hash = contentHash(`${contentText(content, job.kind)}\n${mediaUrlFor(content, job.kind)}`);
            if (
                content.aiMetadata?.status === 'ready' &&
                content.aiMetadata.contentHash === hash &&
                content.aiMetadata.provider === 'gemini'
            ) {
                return;
            }
            const result = await categorizeContent({ content, kind: job.kind });
            await Model.findByIdAndUpdate(job.id, { $set: { aiMetadata: result } });
            if (result.categories?.length && Array.isArray(content.reacts)) {
                await Promise.all(content.reacts
                    .map((react) => react?.profile)
                    .filter(Boolean)
                    .map((profileId) => updateInterestProfile({ profileId, item: { aiMetadata: result } })));
            }
        }
    } catch (error) {
        const Model = job.kind === 'watch' ? Watch : Post;
        await Model.findByIdAndUpdate(job.id, { $set: { 'aiMetadata.status': 'failed', 'aiMetadata.error': String(error.message || error).slice(0, 300) } }).catch((updateError) => {
            console.error('[ai-categorization] failed to persist job error:', updateError.message || updateError);
        });
        console.error('[ai-categorization] job failed:', error.message || error);
    } finally {
        running = false;
        if (queue.length) setImmediate(processNext);
    }
};

const enqueueCategorization = (id, kind) => {
    if (process.env.AI_CATEGORIZATION_ENABLED === 'false') return;
    const key = `${kind}:${String(id)}`;
    if (queuedKeys.has(key)) return;
    queuedKeys.add(key);
    queue.push({ id, kind });
    console.log(`[ai-categorization] queued ${key}`);
    setImmediate(processNext);
};

module.exports = { enqueueCategorization };
