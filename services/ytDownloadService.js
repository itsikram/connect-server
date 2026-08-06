const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const { v2: cloudinary } = require('cloudinary');
const Watch = require('../models/Watch');
const generateAndUploadThumbnail = require('../utils/generateThumbnail');

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

const downloadToFile = (url, info, format, filePath, onProgress) =>
    new Promise((resolve, reject) => {
        const stream = ytdl.downloadFromInfo(info, { format });
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
            {
                resource_type: 'video',
                folder: 'watch-videos',
            },
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

        if (!ytdl.validateURL(url)) {
            throw new Error('Invalid YouTube URL');
        }

        updateProgress(progressId, { stage: 'downloading', status: 'running', pct: 5 });

        const info = await ytdl.getInfo(url);
        const title = info.videoDetails?.title || 'video';
        const format = pickFormat(info.formats, height);

        if (!format) {
            throw new Error('No suitable video format found');
        }

        const safeName = `${progressId}_${sanitizeFileName(title)}.mp4`;
        filePath = path.join(DOWNLOAD_DIR, safeName);

        let lastPct = 5;
        await downloadToFile(url, info, format, filePath, (downloaded) => {
            const contentLength = format.contentLength ? Number(format.contentLength) : 0;
            let pct = lastPct;
            if (contentLength > 0) {
                pct = Math.min(95, Math.round((downloaded / contentLength) * 100));
            } else {
                pct = Math.min(95, lastPct + 1);
            }
            if (pct > lastPct) {
                lastPct = pct;
                updateProgress(progressId, {
                    stage: 'downloading',
                    status: 'running',
                    pct,
                    title,
                    download_title: title,
                });
            }
        });

        const encodedName = encodeURIComponent(path.basename(filePath));
        const fileUrl = `${baseUrl.replace(/\/$/, '')}/files/${encodedName}`;

        let watchPosted = false;

        if (postAsWatch && profileId) {
            updateProgress(progressId, {
                stage: 'uploading_watch',
                status: 'running',
                pct: 96,
                title,
                download_title: title,
            });

            const uploadResult = await uploadVideoToCloudinary(filePath);
            if (!uploadResult?.secure_url) {
                throw new Error('Failed to upload video to cloud storage');
            }

            await createWatchFromVideo(uploadResult.secure_url, title, profileId);
            watchPosted = true;
        }

        updateProgress(progressId, {
            stage: 'completed',
            status: 'completed',
            pct: 100,
            file_url: fileUrl,
            title,
            download_title: title,
            watch_posted: watchPosted,
        });
    } catch (error) {
        console.error('YouTube download job failed:', error);
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (_) {}
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
};
