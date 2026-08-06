const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const { v2: cloudinary } = require('cloudinary');
const Watch = require('../models/Watch');
const generateAndUploadThumbnail = require('../utils/generateThumbnail');
const {
    isYtDlpAvailable,
    downloadWithYtDlp,
    getBundledYtDlpPath,
    isBotBlockError,
    formatBotBlockError,
    normalizeYouTubeUrl,
    isFormatUnavailableError,
} = require('./ytDlpRunner');
const { downloadViaCobalt } = require('./ytCobaltFallback');

const DOWNLOAD_DIR = path.join(require('os').tmpdir(), 'connect-yt-downloads');
const JOB_PROGRESS = new Map();

/** Limit parallel YouTube jobs so home Cobalt / PC stays responsive. */
const YT_DL_MAX_CONCURRENT = Math.max(
    1,
    parseInt(process.env.YT_DL_MAX_CONCURRENT || '2', 10) || 2
);
let ytDownloadActive = 0;
const ytDownloadWaiters = [];

const acquireDownloadSlot = () =>
    new Promise((resolve) => {
        if (ytDownloadActive < YT_DL_MAX_CONCURRENT) {
            ytDownloadActive += 1;
            resolve();
            return;
        }
        ytDownloadWaiters.push(resolve);
    });

const releaseDownloadSlot = () => {
    ytDownloadActive = Math.max(0, ytDownloadActive - 1);
    const next = ytDownloadWaiters.shift();
    if (next) {
        ytDownloadActive += 1;
        next();
    }
};

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
    api_key: process.env.CLOUDINARY_API_KEY || '',
    api_secret: process.env.CLOUDINARY_API_SECRET || '',
});

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const isRenderHost = () =>
    process.env.RENDER === 'true' ||
    process.env.YT_DL_RENDER_MODE === 'true';

let cachedAgent = null;

const getYtdlAgent = () => {
    if (cachedAgent) return cachedAgent;

    const cookiesJson = process.env.YOUTUBE_COOKIES_JSON;
    const cookiesFile = process.env.YOUTUBE_COOKIES_FILE;

    try {
        if (cookiesJson) {
            const cookies = JSON.parse(cookiesJson);
            if (Array.isArray(cookies) && cookies.length) {
                cachedAgent = ytdl.createAgent(cookies);
                return cachedAgent;
            }
        }
        if (cookiesFile && fs.existsSync(cookiesFile)) {
            const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
            if (Array.isArray(cookies) && cookies.length) {
                cachedAgent = ytdl.createAgent(cookies);
                return cachedAgent;
            }
        }
    } catch (err) {
        console.warn('Failed to load YouTube cookies for ytdl-core:', err.message);
    }

    return null;
};

const sanitizeFileName = (name) => {
    if (!name) return 'video';
    return String(name)
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-zA-Z0-9. -]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100) || 'video';
};

const pickFormat = (formats, targetHeight) => {
    const withAv = formats.filter((f) => f.hasVideo && f.hasAudio);
    if (!withAv.length) {
        return ytdl.chooseFormat(formats, { quality: 'highest', filter: 'videoandaudio' });
    }
    if (!targetHeight) {
        return withAv.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    }
    const matching = withAv
        .filter((f) => f.height && f.height <= targetHeight)
        .sort((a, b) => (b.height || 0) - (a.height || 0));
    return matching[0] || withAv.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
};

const updateProgress = (progressId, patch) => {
    const prev = JOB_PROGRESS.get(progressId) || {};
    JOB_PROGRESS.set(progressId, { ...prev, ...patch });
};

const getProgress = (progressId) => JOB_PROGRESS.get(progressId) || null;

const shouldUseYtdlCore = () => {
    if (isRenderHost()) return false;
    if (process.env.YT_DL_USE_YTDL_CORE === 'true') return true;
    if (process.env.YT_DL_USE_YTDL_CORE === 'false') return false;
    if (process.env.NODE_ENV === 'production') return false;
    return true;
};

const isValidYouTubeUrl = (url) =>
    ytdl.validateURL(url) || url.includes('youtube.com') || url.includes('youtu.be');

const downloadToFileYtdlCore = (info, format, filePath, agent, onProgress) =>
    new Promise((resolve, reject) => {
        const stream = ytdl.downloadFromInfo(info, { format, agent: agent || undefined });
        const writeStream = fs.createWriteStream(filePath);
        let downloaded = 0;

        stream.on('data', (chunk) => {
            downloaded += chunk.length;
            if (typeof onProgress === 'function') {
                onProgress(downloaded);
            }
        });

        stream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        stream.pipe(writeStream);
    });

const uploadVideoToCloudinary = (filePath, folder = 'yt-downloads') =>
    new Promise((resolve, reject) => {
        cloudinary.uploader.upload(
            filePath,
            { resource_type: 'video', folder },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
    });

const createWatchFromVideo = async (videoUrl, caption, profileId) => {
    const watchCaption = String(caption || 'YouTube Video').trim().slice(0, 500) || 'YouTube Video';
    let thumbnail = '';
    try {
        const result = await generateAndUploadThumbnail(videoUrl);
        thumbnail = result?.secure_url || '';
    } catch (err) {
        console.warn('Watch thumbnail generation failed:', err.message);
        if (videoUrl && videoUrl.includes('/upload/')) {
            thumbnail = videoUrl
                .replace('/video/upload/', '/video/upload/so_1,w_720,h_405,c_fill/')
                .replace(/\.(mp4|mov|webm|mkv|avi)(\?.*)?$/i, '.jpg$2');
        }
    }

    const watch = new Watch({
        caption: watchCaption,
        videoUrl,
        author: profileId,
        thumbnail,
        feeling: '',
        audience: 3,
    });

    return watch.save();
};

/** Reliable YouTube title for Watch caption (works even when yt-dlp filename is a UUID). */
const fetchYouTubeTitle = async (url) => {
    try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const res = await axios.get(oembedUrl, {
            timeout: 15000,
            headers: { 'User-Agent': 'Connect-Server/1.0' },
        });
        const title = res.data?.title;
        if (title && String(title).trim()) return String(title).trim();
    } catch (err) {
        console.warn('[yt-download] oEmbed title failed:', err.message);
    }
    return null;
};

const downloadWithYtDlpBackend = async ({ progressId, url, height }) => {
    let lastPct = 5;
    const report = (patch) => {
        if (patch.pct !== undefined && patch.pct >= lastPct) {
            lastPct = patch.pct;
        }
        updateProgress(progressId, {
            status: 'running',
            ...patch,
            pct: patch.pct !== undefined ? patch.pct : lastPct,
        });
    };

    if (!(await isYtDlpAvailable())) {
        const bundled = getBundledYtDlpPath();
        throw new Error(
            bundled
                ? 'yt-dlp binary missing or not executable on this server'
                : 'yt-dlp is not installed. Add youtube-dl-exec to package.json and redeploy.'
        );
    }

    console.log('[yt-download] Downloading with yt-dlp on Node.js server');
    report({ stage: 'downloading', pct: 5, source: 'yt-dlp' });

    const { filePath, title } = await downloadWithYtDlp({
        url,
        outputDir: DOWNLOAD_DIR,
        outputPrefix: progressId,
        height,
        onProgress: (pct) => report({ stage: 'downloading', pct, title: 'video', download_title: 'video' }),
    });

    return { title: title || 'video', source: 'yt-dlp', filePath };
};

const downloadViaCobaltBackend = async ({ progressId, url, height }) => {
    let lastPct = 5;
    const report = (pct) => {
        if (pct >= lastPct) lastPct = pct;
        updateProgress(progressId, {
            status: 'running',
            stage: 'downloading',
            pct: lastPct,
            source: 'cobalt',
            title: 'video',
            download_title: 'video',
        });
    };

    console.log('[yt-download] Downloading via Cobalt API');
    report(5);
    return downloadViaCobalt({
        url,
        height,
        outputDir: DOWNLOAD_DIR,
        outputPrefix: progressId,
        onProgress: report,
    });
};

const downloadVideo = async ({ progressId, url, height }) => {
    let lastError = null;
    const cobaltEnabled = process.env.YT_DL_DISABLE_COBALT !== 'true';
    const hasCobaltUrl = Boolean(process.env.COBALT_API_URL);
    const cobaltOnly = process.env.YT_DL_COBALT_ONLY === 'true';
    // Prefer Cobalt on Render, or when YT_DL_PREFER_COBALT / YT_DL_COBALT_ONLY (local test)
    const preferCobalt =
        cobaltEnabled &&
        hasCobaltUrl &&
        (isRenderHost() ||
            process.env.YT_DL_PREFER_COBALT === 'true' ||
            cobaltOnly);

    const tryYtDlp = async () => {
        if (cobaltOnly) {
            console.log('[yt-download] Skipping yt-dlp (YT_DL_COBALT_ONLY=true)');
            return null;
        }
        try {
            return await downloadWithYtDlpBackend({ progressId, url, height });
        } catch (err) {
            lastError = err;
            console.warn('[yt-download] yt-dlp failed:', err.message);
            return null;
        }
    };

    const tryCobalt = async () => {
        if (!cobaltEnabled) return null;
        try {
            return await downloadViaCobaltBackend({ progressId, url, height });
        } catch (cobaltErr) {
            console.warn('[yt-download] Cobalt failed:', cobaltErr.message);
            lastError = cobaltErr;
            return null;
        }
    };

    if (preferCobalt) {
        console.log(
            cobaltOnly
                ? '[yt-download] Cobalt-only mode (local test)'
                : '[yt-download] Prefer Cobalt first'
        );
        const cobaltResult = await tryCobalt();
        if (cobaltResult) return cobaltResult;
        console.warn('[yt-download] Cobalt unavailable — falling back to yt-dlp');
        const ytResult = await tryYtDlp();
        if (ytResult) return ytResult;
    } else {
        const ytResult = await tryYtDlp();
        if (ytResult) return ytResult;
        const cobaltResult = await tryCobalt();
        if (cobaltResult) return cobaltResult;
    }

    // Local-dev-only: ytdl-core
    if (shouldUseYtdlCore() && ytdl.validateURL(url)) {
        const agent = getYtdlAgent();
        const filePath = path.join(DOWNLOAD_DIR, `${progressId}_video.mp4`);
        let lastPct = 5;
        const report = (patch) => {
            if (patch.pct !== undefined && patch.pct >= lastPct) {
                lastPct = patch.pct;
            }
            updateProgress(progressId, {
                status: 'running',
                ...patch,
                pct: patch.pct !== undefined ? patch.pct : lastPct,
            });
        };

        try {
            report({ stage: 'downloading', pct: 5, source: 'ytdl-core' });
            const info = await ytdl.getInfo(url, agent ? { agent } : undefined);
            const title = info.videoDetails?.title || 'video';
            const format = pickFormat(info.formats, height);

            if (!format) {
                throw new Error('No suitable video format found');
            }

            await downloadToFileYtdlCore(info, format, filePath, agent, (downloaded) => {
                const contentLength = format.contentLength ? Number(format.contentLength) : 0;
                let pct = lastPct;
                if (contentLength > 0) {
                    pct = Math.min(95, Math.round((downloaded / contentLength) * 100));
                } else {
                    pct = Math.min(95, lastPct + 1);
                }
                report({ stage: 'downloading', pct, title, download_title: title });
            });

            return { title, source: 'ytdl-core', filePath };
        } catch (ytdlErr) {
            console.warn('[yt-download] ytdl-core failed:', ytdlErr.message);
            if (filePath && fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (_) {}
            }
            lastError = ytdlErr;
        }
    }

    if (isRenderHost() && !hasCobaltUrl) {
        throw new Error(
            'YouTube blocks Render IPs. Localhost works because your home IP is allowed. ' +
            'For the live site, set COBALT_API_URL to your own Cobalt instance on Render, then redeploy. ' +
            'Also copy the same YOUTUBE_COOKIES_B64 that works locally.'
        );
    }

    const msg = lastError?.message || 'YouTube download failed.';
    throw new Error(
        isBotBlockError(msg) || isFormatUnavailableError(msg)
            ? formatBotBlockError()
            : msg
    );
};

const runDownloadJob = async ({
    progressId,
    baseUrl,
    url,
    height,
    postAsWatch,
    profileId,
}) => {
    let filePath = null;
    await acquireDownloadSlot();

    try {
        updateProgress(progressId, { stage: 'starting', status: 'running', pct: 0 });

        const normalizedUrl = normalizeYouTubeUrl(url);
        if (!isValidYouTubeUrl(normalizedUrl)) {
            throw new Error('Invalid YouTube URL');
        }

        // Always post to Watch when the user is authenticated
        const shouldPostWatch = Boolean(profileId) && postAsWatch !== false;

        // Fetch real YouTube title early for Watch caption + UI
        const oembedTitle = await fetchYouTubeTitle(normalizedUrl);
        if (oembedTitle) {
            updateProgress(progressId, {
                title: oembedTitle,
                download_title: oembedTitle,
            });
        }

        const result = await downloadVideo({
            progressId,
            url: normalizedUrl,
            height,
        });

        const looksLikeUuid = (t) => /^[a-f0-9-]{16,}$/i.test(String(t || '').replace(/\s/g, ''));
        const downloadedTitle = result.title && !looksLikeUuid(result.title) ? result.title : null;
        const finalTitle = oembedTitle || downloadedTitle || 'YouTube Video';
        filePath = result.filePath;

        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error('Download completed but file was not found on server');
        }

        updateProgress(progressId, {
            stage: 'uploading',
            status: 'running',
            pct: 96,
            title: finalTitle,
            download_title: finalTitle,
        });

        // Always upload to Cloudinary — do not serve from local/public disk
        const uploadFolder = shouldPostWatch ? 'watch-videos' : 'yt-downloads';
        const uploadResult = await uploadVideoToCloudinary(filePath, uploadFolder);
        if (!uploadResult?.secure_url) {
            throw new Error('Failed to upload video to Cloudinary');
        }

        const fileUrl = uploadResult.secure_url;
        let watchPosted = false;

        if (shouldPostWatch) {
            updateProgress(progressId, {
                stage: 'uploading_watch',
                status: 'running',
                pct: 98,
                title: finalTitle,
                download_title: finalTitle,
            });
            // Caption = YouTube video title
            await createWatchFromVideo(fileUrl, finalTitle, profileId);
            watchPosted = true;
            console.log(`[yt-download] Posted Watch with caption: ${finalTitle.slice(0, 80)}`);
        }

        // Remove temp file after Cloudinary upload
        try { fs.unlinkSync(filePath); } catch (_) {}
        filePath = null;

        updateProgress(progressId, {
            stage: 'completed',
            status: 'completed',
            pct: 100,
            file_url: fileUrl,
            title: finalTitle,
            download_title: finalTitle,
            watch_posted: watchPosted,
            watch_caption: watchPosted ? finalTitle : undefined,
            source: result.source,
            storage: 'cloudinary',
        });
    } catch (error) {
        console.error('YouTube download job failed:', error);
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (_) {}
        }

        updateProgress(progressId, {
            stage: 'failed',
            status: 'failed',
            error: error.message || 'Download failed',
        });
    } finally {
        releaseDownloadSlot();
    }
};

const startDownloadJob = ({ baseUrl, url, height, postAsWatch, profileId }) => {
    const progressId = uuidv4().replace(/-/g, '');

    JOB_PROGRESS.set(progressId, { stage: 'starting', status: 'running', pct: 0 });

    if (isRenderHost()) {
        const bundled = getBundledYtDlpPath();
        console.log('[yt-download] Node.js-only mode on Render. yt-dlp binary:', bundled || 'checking on first download...');
    }

    setImmediate(() => {
        runDownloadJob({
            progressId,
            baseUrl,
            url,
            height,
            postAsWatch,
            profileId,
        });
    });

    return progressId;
};

module.exports = {
    DOWNLOAD_DIR,
    startDownloadJob,
    getProgress,
    isRenderHost,
};
