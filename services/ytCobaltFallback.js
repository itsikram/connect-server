const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');

/**
 * Cobalt API fallback when yt-dlp is blocked on cloud IPs.
 * Set COBALT_API_URL to your instance (recommended).
 * Optional: COBALT_API_KEY for Authorization: Api-Key / Bearer.
 */
const DEFAULT_INSTANCES = [
    process.env.COBALT_API_URL,
    // Public api.cobalt.tools is not intended for apps — only used if no COBALT_API_URL
    !process.env.COBALT_API_URL ? 'https://api.cobalt.tools' : null,
].filter(Boolean);

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
    const body = {
        url: youtubeUrl,
        downloadMode: 'auto',
        videoQuality: heightToQuality(height),
        youtubeVideoCodec: 'h264',
        youtubeVideoContainer: 'mp4',
        filenameStyle: 'basic',
        alwaysProxy: true,
        ...extras,
    };

    const res = await axios.post(endpoint, body, {
        headers: cobaltHeaders(),
        timeout: 120000,
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
    };
};

const downloadFileFromUrl = async (mediaUrl, destPath, onProgress) => {
    // Tunnel/redirect URLs must not get API JSON headers
    const res = await axios.get(mediaUrl, {
        responseType: 'stream',
        timeout: 300000,
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

const downloadViaCobalt = async ({ url, height, outputDir, outputPrefix, onProgress }) => {
    const instances = [...new Set(DEFAULT_INSTANCES.map((u) => u.replace(/\/$/, '')))];
    if (!instances.length) {
        throw new Error('No Cobalt API URL configured. Set COBALT_API_URL.');
    }

    fs.mkdirSync(outputDir, { recursive: true });
    let lastError = null;

    for (const base of instances) {
        try {
            console.log(`[yt-download] Cobalt fallback via ${base}`);
            if (typeof onProgress === 'function') onProgress(8);

            const { mediaUrl, title } = await requestCobalt(base, url, height);
            if (typeof onProgress === 'function') onProgress(15);

            const destPath = path.join(outputDir, `${outputPrefix}.mp4`);
            await downloadFileFromUrl(mediaUrl, destPath, onProgress);

            if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1000) {
                throw new Error('Cobalt download produced an empty file');
            }

            return { filePath: destPath, title: title || 'video', source: 'cobalt' };
        } catch (err) {
            lastError = err;
            console.warn(`[yt-download] Cobalt ${base} failed:`, err.message?.slice(0, 220));
            const partial = path.join(outputDir, `${outputPrefix}.mp4`);
            if (fs.existsSync(partial)) {
                try { fs.unlinkSync(partial); } catch (_) {}
            }
        }
    }

    throw lastError || new Error('All Cobalt instances failed');
};

module.exports = {
    downloadViaCobalt,
};
