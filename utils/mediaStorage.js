const path = require('path')
const { PassThrough } = require('stream')
const ffmpeg = require('fluent-ffmpeg')
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg')
const { v4: uuidv4 } = require('uuid')
const { uploadToDrive, buildMediaUrl } = require('./googleDrive')

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

// Voice notes are recorded as webm/m4a depending on platform. Cloudinary used
// to convert them to mp3 so every client can play them; do the same here.
const transcodeToMp3 = (buffer) => new Promise((resolve, reject) => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks = []
    output.on('data', (chunk) => chunks.push(chunk))
    output.on('end', () => resolve(Buffer.concat(chunks)))
    ffmpeg(input)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('96k')
        .format('mp3')
        .on('error', reject)
        .pipe(output, { end: true })
    input.end(buffer)
})

const getResourceType = (mimeType) => {
    const type = String(mimeType || '').split('/')[0]
    if (type === 'image') return 'image'
    if (type === 'video' || type === 'audio') return 'video'
    return 'raw'
}

// Uploads a multer file to Google Drive and returns a Cloudinary-like result,
// since clients read secure_url / url from the upload response.
const uploadUserMediaToDrive = async (req, file, { kind = 'file', transcodeAudio = false } = {}) => {
    let buffer = file.buffer
    let mimeType = file.mimetype || 'application/octet-stream'
    const parsed = path.parse(String(file.originalname || 'file'))
    let ext = parsed.ext.replace(/^\./, '').toLowerCase()

    if (transcodeAudio) {
        buffer = await transcodeToMp3(buffer)
        mimeType = 'audio/mpeg'
        ext = 'mp3'
    }

    const base = (parsed.name || kind).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || kind
    const name = `${kind}-${Date.now()}-${uuidv4().slice(0, 8)}-${base}${ext ? `.${ext}` : ''}`
    const stored = await uploadToDrive({ buffer, mimeType, name })
    const url = buildMediaUrl(req, stored)

    return {
        provider: 'gdrive',
        public_id: `${stored.account}/${stored.fileId}`,
        resource_type: getResourceType(mimeType),
        format: ext,
        bytes: stored.size,
        original_filename: parsed.name,
        created_at: new Date().toISOString(),
        url,
        secure_url: url,
    }
}

module.exports = { uploadUserMediaToDrive }
