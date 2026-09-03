const { v2: cloudinary } = require('cloudinary')
const streamifier = require('streamifier');


cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '', api_key: process.env.CLOUDINARY_API_KEY || '', api_secret: process.env.CLOUDINARY_API_SECRET  }); // Use multer to store files in memory 

exports.uploadImage = async (req, res, next) => {


    if (!req.file) { return res.status(400).json({ error: 'No file uploaded' }); } // Create an upload stream and pipe the file buffer to Cloudinary 
    let uploadStream = cloudinary.uploader.upload_stream((error, result) => {
        if (error) {
            return res.status(500).json({ error });
        }
        res.json(result);
    });
    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);

}
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
    let uploadStream = cloudinary.uploader.upload_stream(
        {
            resource_type: 'video', // Explicitly specify that it's a video
            public_id: req.file.originalname.split('.')[0], // Optional: Set a custom public ID
            chunk_size: 6000000 // Optional: Set the chunk size for video uploads
        },
        (error, result) => {
            if (error) {
                return res.status(500).json({ error });
            }
            res.json(result);
        }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);

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
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: isAudio ? 'video' : 'auto',
                folder: 'chat-uploads',
                ...(needsAudioTranscode ? { format: 'mp3' } : {}),
            },
            (error, result) => {
                if (error) {
                    console.error('[upload] Cloudinary file upload failed', {
                        name: req.file.originalname,
                        mime: req.file.mimetype,
                        bytes: req.file.size,
                        error: error?.message || error,
                    });
                    return res.status(502).json({ error: error?.message || 'Cloudinary upload failed' });
                }
                // Return full Cloudinary response so client can use secure_url
                return res.status(200).json(result);
            }
        );

        const inputStream = streamifier.createReadStream(req.file.buffer);
        inputStream.on('error', (error) => {
            console.error('[upload] file stream failed', error?.message || error);
            if (!res.headersSent) res.status(500).json({ error: 'File stream failed' });
        });
        uploadStream.on('error', (error) => {
            console.error('[upload] Cloudinary stream failed', error?.message || error);
            if (!res.headersSent) res.status(502).json({ error: error?.message || 'Cloudinary upload failed' });
        });
        inputStream.pipe(uploadStream);
    } catch (err) {
        console.error('[upload] file upload handler failed', err?.message || err);
        return res.status(500).json({ error: err?.message || 'Upload failed' });
    }

}