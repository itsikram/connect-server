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

        const originalName = String(req.file.originalname || '').toLowerCase();
        const mime = String(req.file.mimetype || '').toLowerCase();
        const needsNativeAudio =
            mime.includes('webm') ||
            mime.includes('ogg') ||
            mime.includes('opus') ||
            originalName.endsWith('.webm') ||
            originalName.endsWith('.ogg') ||
            originalName.endsWith('.oga') ||
            originalName.endsWith('.opus');

        // Web voice notes are webm/opus. Native apps cannot play that, so
        // transcode those uploads to mp3 while leaving images and m4a alone.
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                resource_type: needsNativeAudio ? 'video' : 'auto',
                folder: 'chat-uploads',
                ...(needsNativeAudio ? { format: 'mp3' } : {}),
            },
            (error, result) => {
                if (error) {
                    return res.status(500).json({ error });
                }
                // Return full Cloudinary response so client can use secure_url
                return res.status(200).json(result);
            }
        )

        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
    } catch (err) {
        return res.status(500).json({ error: 'Upload failed' });
    }

}