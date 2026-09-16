const streamifier = require('streamifier');
const { withCloudinaryAccount } = require('../utils/cloudinary')

const getCloudinaryErrorResponse = (error) => {
    const message = String(error?.message || error || 'Cloudinary upload failed');
    const blocked = /blocked|suspend|disabled|terms of use|acceptable use|prohibited|under review/i.test(message);

    return {
        status: blocked ? 503 : 502,
        body: {
            error: blocked
                ? 'Media uploads are temporarily unavailable while the media provider reviews this account.'
                : message,
            code: blocked ? 'MEDIA_PROVIDER_BLOCKED' : 'MEDIA_UPLOAD_FAILED',
        },
    };
};

const sendCloudinaryError = (res, error, context) => {
    const response = getCloudinaryErrorResponse(error);
    console.error(`[upload] ${context}`, {
        status: response.status,
        code: response.body.code,
        error: error?.message || error,
    });
    if (!res.headersSent) {
        res.status(response.status).json(response.body);
    }
};

exports.uploadImage = async (req, res, next) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!req.file.buffer || req.file.buffer.length === 0) {
        return res.status(400).json({ error: 'Uploaded file is empty' });
    }

    try {
        await withCloudinaryAccount('image', (cloudinary) => new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                { resource_type: 'image' },
                (error, result) => {
                    if (error) {
                        console.error('[upload] Cloudinary image upload failed', error?.message || error);
                        sendCloudinaryError(res, error, 'Cloudinary image upload failed');
                        return reject(error);
                    }
                    res.status(200).json(result);
                    resolve(result);
                }
            );
            const inputStream = streamifier.createReadStream(req.file.buffer);
            inputStream.on('error', reject);
            uploadStream.on('error', reject);
            inputStream.pipe(uploadStream);
        }));
    } catch (error) {
        console.error('[upload] image upload handler failed', error?.message || error);
        if (!res.headersSent) return res.status(500).json({ error: error?.message || 'Upload failed' });
    }
};
exports.uploadVideo = async (req, res, next) => {

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Optional: validate file type before uploading
    const fileType = req.file.mimetype.split('/')[0];

    if (fileType !== 'video') {
        return res.status(400).json({ error: 'Uploaded file is not a video' });
    }

    // Create an upload stream and pipe the file buffer to Cloudinary
    try {
        await withCloudinaryAccount('video', (cloudinary) => new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    resource_type: 'video',
                    public_id: req.file.originalname.split('.')[0],
                    chunk_size: 6000000
                },
                (error, result) => {
                    if (error) {
                        sendCloudinaryError(res, error, 'Cloudinary video upload failed');
                        return reject(error);
                    }
                    res.json(result);
                    resolve(result);
                }
            );
            const inputStream = streamifier.createReadStream(req.file.buffer);
            inputStream.on('error', reject);
            uploadStream.on('error', reject);
            inputStream.pipe(uploadStream);
        }));
    } catch (error) {
        if (!res.headersSent) return res.status(500).json({ error: error?.message || 'Upload failed' });
    }

};


exports.uploadFile = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        if (!req.file.buffer || req.file.buffer.length < 1024) {
            console.warn('[upload] rejecting empty or truncated file', {
                name: req.file.originalname,
                mime: req.file.mimetype,
                bytes: req.file.buffer?.length || 0,
            });
            return res.status(400).json({ error: 'Uploaded file is empty or truncated' });
        }

        const originalName = String(req.file.originalname || '').toLowerCase();
        const mime = String(req.file.mimetype || '').toLowerCase();
        const isAudio = mime.startsWith('audio/') ||
            /\.(m4a|mp3|wav|aac|flac|webm|ogg|oga|opus)$/i.test(originalName);
        const needsAudioTranscode = isAudio;

        // Cloudinary uses resource_type=video for audio files. Web voice notes
        // are transcoded to mp3 so native clients can play them consistently.
        const account = isAudio || mime.startsWith('video/') ? 'video' : 'image';
        await withCloudinaryAccount(account, (cloudinary) => new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    resource_type: isAudio ? 'video' : 'auto',
                    folder: 'chat-uploads',
                    ...(needsAudioTranscode ? { format: 'mp3' } : {}),
                },
                (error, result) => {
                    if (error) {
                        console.error('[upload] Cloudinary file upload failed', error?.message || error);
                        sendCloudinaryError(res, error, 'Cloudinary file upload failed');
                        return reject(error);
                    }
                    res.status(200).json(result);
                    resolve(result);
                }
            );
            const inputStream = streamifier.createReadStream(req.file.buffer);
            inputStream.on('error', reject);
            uploadStream.on('error', reject);
            inputStream.pipe(uploadStream);
        }));
    } catch (err) {
        console.error('[upload] file upload handler failed', err?.message || err);
        if (!res.headersSent) return res.status(500).json({ error: err?.message || 'Upload failed' });
    }

}