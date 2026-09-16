const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { withCloudinaryAccount } = require('./cloudinary');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Cloudinary config
async function generateAndUploadThumbnail(videoUrl) {
  const tempDir = path.join(__dirname, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const videoFilename = `video - ${ uuidv4()
}.mp4`;
const thumbnailFilename = `thumb - ${ uuidv4()}.png`;
const videoPath = path.join(tempDir, videoFilename);
const thumbnailPath = path.join(tempDir, thumbnailFilename);

try {
  // Step 1: Download the video to disk
  const response = await axios.get(videoUrl, { responseType: 'stream' });
  const writer = fs.createWriteStream(videoPath);

  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  // Step 2: Generate thumbnail from local video
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on('end', resolve)
      .on('error', reject)
      .screenshots({
        timestamps: ['00:00:01'],
        filename: thumbnailFilename,
        folder: tempDir,
        size: '1080x768',
      });
  });

  // Step 3: Upload to Cloudinary
  const result = await withCloudinaryAccount('image', (cloudinary) =>
    cloudinary.uploader.upload(thumbnailPath, {
      folder: 'video-thumbnails',
      resource_type: 'image',
    }),
  );

  // Step 4: Cleanup
  fs.unlinkSync(videoPath);
  fs.unlinkSync(thumbnailPath);

  return result;

} catch (error) {
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  if (fs.existsSync(thumbnailPath)) fs.unlinkSync(thumbnailPath);
  throw new Error('Failed to process video: ' + error.message);
}
}




module.exports = generateAndUploadThumbnail
