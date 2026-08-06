const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');

/**
 * Cobalt API fallback when yt-dlp is blocked on cloud IPs.
 * Set COBALT_API_URL to your instance (recommended).
 * Optional: COBALT_API_KEY for Authorization: Api-Key / Bearer.
 */
const getCobaltInstances = () => {
    const primary = process.env.COBALT_API_URL;
    const fallback = !primary ? 'https://api.cobalt.tools' : null;
    return [...new Set([primary, fallback].filter(Boolean).map((u) => u.replace(/\/$/, '')))];
};

const isRemoteHomeCobalt = () => {
    const u = process.env.COBALT_API_URL || '';
    return u.startsWith('http') && !/localhost|127\.0\.0\.1/i.test(u);
};

const cobaltApiTimeoutMs = () =>
    Number(process.env.COBALT_API_TIMEOUT_MS) || (isRemoteHomeCobalt() ? 180000 : 120000);

const cobaltMediaTimeoutMs = () =>
    Number(process.env.COBALT_MEDIA_TIMEOUT_MS) || (isRemoteHomeCobalt() ? 420000 : 300000);

const heightToQuality = (height) => {
    if (!height) return '720';
    const allowed = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
    const match = allowed.find((q) => q >= height) || allowed[allowed.length - 1];
    // Prefer exact or next-lower for speed on free tier
    const lower = [...allowed].reverse().find((q) => q <= height);
    return String(lower || match);
};

const cobaltHeaders = () => {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Connect-Server/1.0',
    };
    const key = process.env.COBALT_API_KEY;
    if (key) {
        headers.Authorization = key.startsWith('Bearer ') || key.startsWith('Api-Key ')
            ? key
            : `Api-Key ${key}`;
    }
    return headers;
};

const resolveDownloadUrl = (data) => {
    if (!data || typeof data !== 'object') return null;
    if (data.status === 'error') return null;
    if (data.url) return data.url;
    if (data.tunnel) return data.tunnel;
    if (Array.isArray(data.picker) && data.picker[0]?.url) return data.picker[0].url;
    return null;
};

const requestCobalt = async (baseUrl, youtubeUrl, height, extras = {}) => {
    const endpoint = baseUrl.replace(/\/$/, '') + '/';
    const { videoQuality, ...rest } = extras;
    const body = {
        url: youtubeUrl,
        downloadMode: 'auto',
        videoQuality: videoQuality || heightToQuality(height),
        youtubeVideoCodec: 'h264',
        youtubeVideoContainer: 'mp4',
        filenameStyle: 'basic',
        alwaysProxy: true,
        ...rest,
    };

    const res = await axios.post(endpoint, body, {
        headers: cobaltHeaders(),
        timeout: cobaltApiTimeoutMs(),
        validateStatus: () => true,
    });

    if (res.status >= 400 || res.data?.status === 'error') {
        const msg = res.data?.error?.code || res.data?.text || res.data?.error || `HTTP ${res.status}`;
        throw new Error(`Cobalt ${endpoint} error: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`);
    }

    const mediaUrl = resolveDownloadUrl(res.data);
    if (!mediaUrl) {
        throw new Error(`Cobalt returned no media URL (${res.data?.status || res.status})`);
    }

    return {
        mediaUrl,
        filename: res.data?.filename || null,
        title: res.data?.filename
            ? String(res.data.filename).replace(/\.[^.]+$/, '')
            : 'video',
        status: res.data?.status || null,
    };
};

const downloadFileFromUrl = async (mediaUrl, destPath, onProgress) => {
    // Tunnel/redirect URLs must not get API JSON headers
    const res = await axios.get(mediaUrl, {
        responseType: 'stream',
        timeout: cobaltMediaTimeoutMs(),
        headers: {
            Accept: '*/*',
            'User-Agent': 'Connect-Server/1.0',
        },
        maxRedirects: 5,
        validateStatus: () => true,
    });

    if (res.status >= 400) {
        // Drain and throw
        const chunks = [];
        for await (const chunk of res.data) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
        throw new Error(`Cobalt media download HTTP ${res.status}: ${body}`);
    }

    const contentType = String(res.headers['content-type'] || '');
    if (contentType.includes('application/json')) {
        const chunks = [];
        for await (const chunk of res.data) chunks.push(chunk);
        throw new Error(`Cobalt returned JSON instead of video: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`);
    }

    const total = Number(res.headers['content-length'] || res.headers['estimated-content-length'] || 0);
    // Cobalt closes the tunnel empty when YouTube HEAD fails (bot/cookies)
    if (total === 0 && String(res.headers['content-length']) === '0') {
        res.data.destroy?.();
        throw new Error('Cobalt download too small (0 bytes)');
    }

    let downloaded = 0;

    res.data.on('data', (chunk) => {
        downloaded += chunk.length;
        if (typeof onProgress === 'function') {
            if (total > 0) {
                onProgress(Math.min(95, Math.round((downloaded / total) * 100)));
            } else {
                onProgress(Math.min(95, 10 + Math.floor(downloaded / (1024 * 1024))));
            }
        }
    });

    await pipeline(res.data, fs.createWriteStream(destPath));

    if (downloaded < 1000 && fs.existsSync(destPath) && fs.statSync(destPath).size < 1000) {
        throw new Error(`Cobalt download too small (${fs.statSync(destPath).size} bytes)`);
    }
};

/** Few quality attempts — empty tunnels are usually bot/IP blocks, not quality. */
const buildAttemptExtras = (height) => {
    const q = Math.min(Number(heightToQuality(height)) || 720, 720);
    return [{ videoQuality: String(q) }, { videoQuality: '360' }]
        .filter((a, i, arr) => arr.findIndex((b) => b.videoQuality === a.videoQuality) === i);
};

const downloadViaCobalt = async ({ url, height, outputDir, outputPrefix, onProgress }) => {
    const instances = getCobaltInstances();
    if (!instances.length) {
        throw new Error('No Cobalt API URL configured. Set COBALT_API_URL.');
    }

    fs.mkdirSync(outputDir, { recursive: true });
    let lastError = null;
    const attempts = buildAttemptExtras(height);

    for (const base of instances) {
        for (const extras of attempts) {
            const destPath = path.join(outputDir, `${outputPrefix}.mp4`);
            try {
                console.log(
                    `[yt-download] Cobalt via ${base} quality=${extras.videoQuality}${extras.youtubeHLS ? ' hls' : ''}`
                );
                if (typeof onProgress === 'function') onProgress(8);

                const { mediaUrl, title } = await requestCobalt(base, url, height, extras);
                if (typeof onProgress === 'function') onProgress(15);

                await downloadFileFromUrl(mediaUrl, destPath, onProgress);

                if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1000) {
                    throw new Error('Cobalt download produced an empty file');
                }

                return { filePath: destPath, title: title || 'video', source: 'cobalt' };
            } catch (err) {
                lastError = err;
                console.warn(`[yt-download] Cobalt ${base} failed:`, err.message?.slice(0, 220));
                if (fs.existsSync(destPath)) {
                    try { fs.unlinkSync(destPath); } catch (_) {}
                }
            }
        }
    }

    throw lastError || new Error('All Cobalt instances failed');
};

module.exports = {
    downloadViaCobalt,
};
