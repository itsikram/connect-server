const { prisma } = require('../utils/db');
const { withAiMetadata, aiMetadataData } = require('./contentShape');

const delegateFor = (kind) => (kind === 'watch' ? prisma.watch : prisma.post);
const reactsRelation = { select: { profile: true }, orderBy: { createdAt: 'asc' } };

/** updateMany so a deleted post/watch is a no-op, like findByIdAndUpdate on a missing id. */
const setAiColumns = (kind, id, meta) =>
    delegateFor(kind).updateMany({ where: { id: String(id) }, data: aiMetadataData(meta) });
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
        await setAiColumns(job.kind, job.id, { status: 'pending', error: null });
        const content = withAiMetadata(await delegateFor(job.kind).findUnique({
            where: { id: String(job.id) },
            include: { reacts: reactsRelation },
        }));
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
            await setAiColumns(job.kind, job.id, result);
            if (result.categories?.length && Array.isArray(content.reacts)) {
                await Promise.all(content.reacts
                    .map((react) => react?.profile)
                    .filter(Boolean)
                    .map((profileId) => updateInterestProfile({ profileId, item: { aiMetadata: result } })));
            }
        }
    } catch (error) {
        await setAiColumns(job.kind, job.id, { status: 'failed', error: String(error.message || error).slice(0, 300) }).catch((updateError) => {
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
