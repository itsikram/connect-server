const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const { v2: cloudinary } = require('cloudinary');
const Watch = require('../models/Watch');
const generateAndUploadThumbnail = require('../utils/generateThumbnail');
const {
    isYtDlpAvailable,
    getVideoTitle,
    downloadWithYtDlp,
    getBundledYtDlpPath,
    isBotBlockError,
    formatBotBlockError,
} = require('./ytDlpRunner');

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

const downloadWithYtDlpBackend = async ({ progressId, url, height, filePath }) => {
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

    return { title, source: 'yt-dlp' };
};

const downloadVideo = async ({ progressId, url, height, filePath }) => {
    // Primary: yt-dlp via youtube-dl-exec (Node.js — works on Render)
    try {
        return await downloadWithYtDlpBackend({ progressId, url, height, filePath });
    } catch (err) {
        console.warn('[yt-download] yt-dlp failed:', err.message);
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (_) {}
        }

        // Fallback for local dev only — ytdl-core (blocked on cloud IPs)
        if (shouldUseYtdlCore() && ytdl.validateURL(url)) {
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

                return { title, source: 'ytdl-core' };
            } catch (ytdlErr) {
                console.warn('[yt-download] ytdl-core failed:', ytdlErr.message);
                if (filePath && fs.existsSync(filePath)) {
                    try { fs.unlinkSync(filePath); } catch (_) {}
                }
            }
        }

        throw new Error(
            isBotBlockError(err.message)
                ? formatBotBlockError()
                : (err.message || 'YouTube download failed.')
        );
    }
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
        const finalName = `${progressId}_${sanitizeFileName(finalTitle)}.mp4`;
        const finalPath = path.join(DOWNLOAD_DIR, finalName);
        if (fs.existsSync(filePath) && finalPath !== filePath) {
            fs.renameSync(filePath, finalPath);
            filePath = finalPath;
        }

        const encodedName = encodeURIComponent(path.basename(filePath));
        const fileUrl = `${baseUrl.replace(/\/$/, '')}/files/${encodedName}`;

        let watchPosted = false;

        if (postAsWatch && profileId) {
            updateProgress(progressId, {
                stage: 'uploading_watch',
                status: 'running',
                pct: 96,
                title: finalTitle,
                download_title: finalTitle,
            });

            const uploadResult = await uploadVideoToCloudinary(filePath);
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

        updateProgress(progressId, {
            stage: 'failed',
            status: 'failed',
            error: error.message || 'Download failed',
        });
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
