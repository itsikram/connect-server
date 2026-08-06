const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const { v2: cloudinary } = require('cloudinary');
const Watch = require('../models/Watch');
const generateAndUploadThumbnail = require('../utils/generateThumbnail');
const { isYtDlpAvailable, getVideoTitle, downloadWithYtDlp } = require('./ytDlpRunner');
const { downloadViaFallbackApi } = require('./ytFallbackApi');

const DOWNLOAD_DIR = path.join(__dirname, '..', 'downloads');
const JOB_PROGRESS = new Map();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
    api_key: process.env.CLOUDINARY_API_KEY || '',
    api_secret: process.env.CLOUDINARY_API_SECRET || '',
});

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/** Render native Node has no Python/ffmpeg — use external yt-dlp service instead. */
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
        console.warn('Failed to load YouTube cookies:', err.message);
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

const isRateLimitError = (error) => {
    const msg = String(error?.message || error || '').toLowerCase();
    return error?.statusCode === 429 || msg.includes('429') || msg.includes('too many requests');
};

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

const copyRemoteFileToLocal = async (remoteUrl, filePath, onProgress) => {
    const response = await axios.get(remoteUrl, {
        responseType: 'stream',
        timeout: 600000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    const total = Number(response.headers['content-length']) || 0;
    let downloaded = 0;

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filePath);
        response.data.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total > 0 && typeof onProgress === 'function') {
                onProgress(Math.min(95, Math.round((downloaded / total) * 100)));
            }
        });
        response.data.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', resolve);
        response.data.pipe(writer);
    });
};

const uploadVideoToCloudinary = (filePath) =>
    new Promise((resolve, reject) => {
        cloudinary.uploader.upload(
            filePath,
            { resource_type: 'video', folder: 'watch-videos' },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
    });

const uploadVideoFromUrl = (remoteUrl) =>
    new Promise((resolve, reject) => {
        cloudinary.uploader.upload(
            remoteUrl,
            { resource_type: 'video', folder: 'watch-videos' },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
    });

const createWatchFromVideo = async (videoUrl, caption, profileId) => {
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
        caption: caption || 'YouTube Video',
        videoUrl,
        author: profileId,
        thumbnail,
        feeling: '',
        audience: 3,
    });

    return watch.save();
};

const runFallbackDownload = async ({ progressId, url, height, copyLocally, filePath }) => {
    const fallbackUrl = process.env.YT_DL_FALLBACK_URL || 'https://yt-dl-ufvy.onrender.com';
    console.log('[yt-download] Using yt-dlp fallback service:', fallbackUrl);

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

    report({ stage: 'downloading', pct: 5, source: 'fallback-api' });

    const fallback = await downloadViaFallbackApi({
        url,
        height,
        onProgress: ({ pct, stage, title }) => {
            report({
                stage: stage || 'downloading',
                pct: pct || lastPct,
                title,
                download_title: title,
            });
        },
    });

    if (copyLocally && filePath) {
        report({ stage: 'downloading', pct: 90, title: fallback.title, download_title: fallback.title });
        await copyRemoteFileToLocal(fallback.fileUrl, filePath, (pct) => {
            report({ stage: 'downloading', pct, title: fallback.title, download_title: fallback.title });
        });
        return { title: fallback.title, source: 'fallback-api', fileUrl: null, remoteFileUrl: fallback.fileUrl };
    }

    return {
        title: fallback.title,
        source: 'fallback-api',
        fileUrl: fallback.fileUrl,
        remoteFileUrl: fallback.fileUrl,
        remoteOnly: true,
    };
};

const downloadVideo = async ({ progressId, url, height, filePath }) => {
    // Render free tier: no Python/ffmpeg — delegate to separate yt-dlp service
    if (isRenderHost()) {
        return runFallbackDownload({ progressId, url, height, copyLocally: false, filePath });
    }

    const agent = getYtdlAgent();
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

    // Local dev: try yt-dlp binary first
    if (await isYtDlpAvailable()) {
        try {
            console.log('[yt-download] Trying yt-dlp backend');
            report({ stage: 'downloading', pct: 5, source: 'yt-dlp' });
            let title = 'video';
            try {
                title = await getVideoTitle(url);
            } catch (_) {}

            await downloadWithYtDlp({
                url,
                outputPath: filePath,
                height,
                onProgress: (pct) => report({ stage: 'downloading', pct, title, download_title: title }),
            });

            return { title, source: 'yt-dlp', fileUrl: null, remoteOnly: false };
        } catch (err) {
            console.warn('yt-dlp download failed, trying next method:', err.message);
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (_) {}
            }
        }
    }

    // Local dev only: ytdl-core
    if (shouldUseYtdlCore() && ytdl.validateURL(url)) {
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

            return { title, source: 'ytdl-core', fileUrl: null, remoteOnly: false };
        } catch (err) {
            console.warn('ytdl-core failed:', err.message);
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (_) {}
            }
            if (!isRateLimitError(err) && process.env.YT_DL_SKIP_FALLBACK === 'true') {
                throw err;
            }
        }
    }

    return runFallbackDownload({ progressId, url, height, copyLocally: true, filePath });
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

    try {
        updateProgress(progressId, { stage: 'starting', status: 'running', pct: 0 });

        const normalizedUrl = (url || '').replace('m.youtube.com', 'www.youtube.com');
        if (!isValidYouTubeUrl(normalizedUrl)) {
            throw new Error('Invalid YouTube URL');
        }

        const safeName = `${progressId}_video.mp4`;
        filePath = path.join(DOWNLOAD_DIR, safeName);

        const result = await downloadVideo({
            progressId,
            url: normalizedUrl,
            height,
            filePath,
        });

        const finalTitle = result.title || 'video';
        let fileUrl;
        let watchPosted = false;

        if (result.remoteOnly && result.fileUrl) {
            // Render mode: use the yt-dlp service download link directly
            fileUrl = result.fileUrl;
        } else {
            const finalName = `${progressId}_${sanitizeFileName(finalTitle)}.mp4`;
            const finalPath = path.join(DOWNLOAD_DIR, finalName);
            if (fs.existsSync(filePath) && finalPath !== filePath) {
                fs.renameSync(filePath, finalPath);
                filePath = finalPath;
            }
            const encodedName = encodeURIComponent(path.basename(filePath));
            fileUrl = `${baseUrl.replace(/\/$/, '')}/files/${encodedName}`;
        }

        if (postAsWatch && profileId) {
            updateProgress(progressId, {
                stage: 'uploading_watch',
                status: 'running',
                pct: 96,
                title: finalTitle,
                download_title: finalTitle,
            });

            const uploadResult = result.remoteOnly
                ? await uploadVideoFromUrl(result.remoteFileUrl || fileUrl)
                : await uploadVideoToCloudinary(filePath);

            if (!uploadResult?.secure_url) {
                throw new Error('Failed to upload video to cloud storage');
            }

            await createWatchFromVideo(uploadResult.secure_url, finalTitle, profileId);
            watchPosted = true;
        }

        updateProgress(progressId, {
            stage: 'completed',
            status: 'completed',
            pct: 100,
            file_url: fileUrl,
            title: finalTitle,
            download_title: finalTitle,
            watch_posted: watchPosted,
            source: result.source,
        });
    } catch (error) {
        console.error('YouTube download job failed:', error);
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (_) {}
        }

        const message = isRateLimitError(error)
            ? 'YouTube is temporarily blocking downloads. Please try again in a few minutes.'
            : (error.message || 'Download failed');

        updateProgress(progressId, {
            stage: 'failed',
            status: 'failed',
            error: message,
        });
    }
};

const startDownloadJob = ({ baseUrl, url, height, postAsWatch, profileId }) => {
    const progressId = uuidv4().replace(/-/g, '');

    JOB_PROGRESS.set(progressId, { stage: 'starting', status: 'running', pct: 0 });

    if (isRenderHost()) {
        console.log('[yt-download] Render mode: using external yt-dlp service (no local download)');
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
