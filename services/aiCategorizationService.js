const crypto = require('crypto');
const axios = require('axios');
const { loadAiSettings, getProviderKey, isProviderEnabled } = require('../utils/aiSettingsStore');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const MAX_RETRIES = Math.max(0, Number(process.env.AI_MAX_RETRIES || 3));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const contentText = (content, kind) => [
    content?.caption,
    content?.feelings,
    content?.feeling,
    content?.location,
    content?.title,
    content?.description,
    content?.text,
    content?.content,
    content?.body,
].filter((value) => typeof value === 'string' && value.trim()).join('\n').trim().slice(0, 8000);

const contentHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

const mediaUrlFor = (content, kind) => {
    if (kind === 'watch') return content?.thumbnail || content?.videoUrl || '';
    return content?.photos || content?.photo || content?.imageUrl || '';
};

const mediaPartFor = async (content, kind) => {
    const url = mediaUrlFor(content, kind);
    if (!/^https?:\/\//i.test(String(url))) return null;
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 8 * 1024 * 1024,
    });
    const contentType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
    const mimeType = contentType.startsWith('image/') ? contentType : 'image/jpeg';
    return { inlineData: { mimeType, data: Buffer.from(response.data).toString('base64') } };
};

const requestWithRetry = async (request) => {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
            return await request();
        } catch (error) {
            lastError = error;
            const status = error?.response?.status;
            if (attempt === MAX_RETRIES || (status && ![408, 429, 500, 502, 503, 504].includes(status))) {
                throw error;
            }
            await sleep(Math.min(8000, 250 * (2 ** attempt)));
        }
    }
    throw lastError;
};

const parseJson = (value) => {
    if (value && typeof value === 'object') return value;
    const text = String(value || '').replace(/```json|```/g, '').trim();
    try { return JSON.parse(text); } catch (_) { return null; }
};

const fallbackCategories = (text) => {
    const categoryKeywords = {
        technology: ['technology', 'tech', 'software', 'app', 'computer', 'ai', 'coding', 'programming'],
        fitness: ['fitness', 'workout', 'gym', 'exercise', 'health', 'training'],
        comedy: ['comedy', 'funny', 'joke', 'humor'],
        music: ['music', 'song', 'sing', 'guitar', 'concert'],
        education: ['education', 'learn', 'tutorial', 'course', 'study', 'lesson'],
        travel: ['travel', 'trip', 'vacation', 'tour', 'hotel'],
        food: ['food', 'recipe', 'cooking', 'restaurant', 'meal'],
        sports: ['sport', 'football', 'cricket', 'basketball', 'soccer', 'match'],
        news: ['news', 'breaking', 'politics', 'election'],
        lifestyle: ['lifestyle', 'fashion', 'beauty', 'home', 'daily'],
        gaming: ['gaming', 'game', 'playstation', 'xbox', 'nintendo'],
    };
    const lower = text.toLowerCase();
    const hashtagCategories = [...text.matchAll(/#([a-z0-9_-]+)/gi)]
        .map((match) => match[1].toLowerCase())
        .filter(Boolean);
    const matchedCategories = Object.entries(categoryKeywords)
        .filter(([, keywords]) => keywords.some((keyword) => lower.includes(keyword)))
        .map(([category]) => category)
        .slice(0, 5);
    const categories = [...new Set([...hashtagCategories, ...matchedCategories])].slice(0, 5);
    return categories.length ? categories : ['general'];
};

const errorMessage = (error) => {
    const status = error?.response?.status;
    if (status === 401) return 'AI provider authentication failed (check the configured API key)';
    if (status) return `AI provider request failed with status ${status}`;
    return String(error?.message || error).slice(0, 300);
};

const complete = async (provider, key, model, text, mediaPart) => {
    if (provider === 'ollama' || provider === 'openai' || provider === 'groq' || provider === 'grok') {
        const base = provider === 'groq' ? 'https://api.groq.com/openai/v1' : provider === 'grok' ? 'https://api.x.ai/v1' : provider === 'ollama' ? String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$ /, '') : 'https://api.openai.com/v1';
        const response = await requestWithRetry(() => axios.post(`${base}/chat/completions`, {
            model: model || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Return only JSON: {"categories":["lowercase tags"],"sentiment":"positive|neutral|negative","contentSafetyFlags":["nsfw|spam|violence"]}. Use at most 5 categories and [] when none.' },
                { role: 'user', content: text },
            ],
            temperature: 0,
            max_tokens: 180,
        }, {
            headers: (() => {
                const h = { 'Content-Type': 'application/json' };
                if (key && provider !== 'ollama') h.Authorization = `Bearer ${key}`;
                return h;
            })(),
            timeout: 30000
        }));
        return parseJson(response.data?.choices?.[0]?.message?.content);
    }
    if (provider === 'gemini') {
        const response = await requestWithRetry(() => axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(key)}`, {
            contents: [{ role: 'user', parts: [
                { text: `Classify this content and attached media accurately. Return a JSON object with exactly these keys: categories (an array of lowercase strings, maximum 5), sentiment (positive, neutral, or negative), and contentSafetyFlags (an array). Content:\n${text || '(no text; use the media)'}` },
                ...(mediaPart ? [mediaPart] : []),
            ] }],
            generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }, { timeout: 30000 }));
        return parseJson((response.data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join(''));
    }
    return null;
};

const createEmbedding = async (key, text) => {
    return null;
    if (!key) return null;
    const response = await requestWithRetry(() => axios.post('https://api.openai.com/v1/embeddings', {
        model: OPENAI_EMBEDDING_MODEL,
        input: text,
    }, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        timeout: 30000
    }));
    return response.data?.data?.[0]?.embedding || null;
};

const categorizeContent = async ({ content, kind }) => {
    const text = contentText(content, kind);
    const mediaUrl = mediaUrlFor(content, kind);
    const hash = contentHash(`${text}\n${mediaUrl}`);
    if (!text && !mediaUrl) return { contentHash: hash, categories: [], embedding: null, status: 'ready' };
    const settings = await loadAiSettings();
    const provider = 'gemini';
    let classification = null;
    let classificationError = null;
    let mediaPart = null;
    try {
        mediaPart = await mediaPartFor(content, kind);
    } catch (error) {
        classificationError = `Media unavailable: ${errorMessage(error)}`;
        console.error(`[ai-categorization] media: ${classificationError}`);
    }
    const providers = [provider];
    let classificationProvider = null;
    for (const candidate of providers) {
        const enabled = await isProviderEnabled(candidate);
        const key = await getProviderKey(candidate);
        if (!enabled || (candidate !== 'ollama' && !key)) continue;
        try {
            classification = await complete(candidate, key, settings.models?.[candidate], text, mediaPart);
            if (classification) {
                classificationProvider = candidate;
                break;
            }
        } catch (error) {
            classificationError = errorMessage(error);
            console.error(`[ai-categorization] ${candidate}: ${classificationError}`);
        }
    }
    const geminiKey = await getProviderKey('gemini');
    let embedding = null;
    let embeddingError = null;
    if (geminiKey && await isProviderEnabled('gemini')) {
        try {
            embedding = await createEmbedding(geminiKey, text);
        } catch (error) {
            embeddingError = errorMessage(error);
            console.error(`[ai-categorization] embedding unavailable: ${embeddingError}`);
        }
    }
    return {
        status: 'ready',
        contentHash: hash,
        categories: Array.isArray(classification?.categories) && classification.categories.length
            ? classification.categories.map((item) => String(item).toLowerCase().trim()).filter(Boolean).slice(0, 5)
            : fallbackCategories(text),
        embedding,
        embeddingModel: undefined,
        provider: classificationProvider || 'fallback',
        sentiment: classification?.sentiment || 'neutral',
        contentSafetyFlags: Array.isArray(classification?.contentSafetyFlags) ? classification.contentSafetyFlags : [],
        processedAt: new Date(),
        error: (classification ? embeddingError : classificationError || embeddingError) || undefined,
    };
};

module.exports = { categorizeContent, contentText, contentHash, mediaUrlFor };