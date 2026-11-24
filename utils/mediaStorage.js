const fs = require('fs')
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
    const url = await buildMediaUrl(req, stored)

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

const guessMimeType = (name, fallback = 'application/octet-stream') => {
    const ext = path.extname(String(name || '')).replace(/^\./, '').toLowerCase()
    return {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
        mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
        pdf: 'application/pdf',
    }[ext] || fallback
}

/**
 * Stores server-generated media (YouTube downloads, thumbnails, AI images).
 * Google Drive is used whenever Drive storage is on; Cloudinary is only the
 * fallback when an admin turns Drive uploads off. Pass `filePath`, `buffer`
 * or `sourceUrl`. Returns a Cloudinary-like result (secure_url, url, public_id).
 */
const storeMedia = async ({ filePath, buffer, sourceUrl, mimeType, name, kind = 'file', folder, req = null, baseUrl = null }) => {
    const { isDriveStorageEnabled, resolveMediaBase, mediaUrlFor } = require('./googleDrive')
    if (await isDriveStorageEnabled()) {
        // Work out the link first, so a missing base URL never leaves an unlinked file in Drive
        const base = await resolveMediaBase(req || baseUrl)
        let size
        if (sourceUrl && !buffer && !filePath) {
            const response = await require('axios').get(sourceUrl, { responseType: 'arraybuffer', timeout: 120000 })
            buffer = Buffer.from(response.data)
            mimeType = mimeType || String(response.headers['content-type'] || '').split(';')[0]
        }
        if (filePath && !buffer) size = (await fs.promises.stat(filePath)).size
        const baseName = name || path.basename(filePath || '') || `${kind}`
        const type = mimeType || guessMimeType(baseName)
        const ext = path.extname(baseName) || ''
        const stem = path.basename(baseName, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || kind
        const stored = await uploadToDrive({
            buffer,
            filePath: buffer ? undefined : filePath,
            size: buffer ? buffer.length : size,
            mimeType: type,
            name: `${kind}-${Date.now()}-${uuidv4().slice(0, 8)}-${stem}${ext}`,
        })
        const url = mediaUrlFor(base, stored)
        return {
            provider: 'gdrive',
            public_id: `${stored.account}/${stored.fileId}`,
            resource_type: getResourceType(type),
            bytes: stored.size,
            url,
            secure_url: url,
        }
    }

    const { withCloudinaryAccount } = require('./cloudinary')
    const type = mimeType || guessMimeType(name || filePath || sourceUrl || '')
    const resourceType = getResourceType(type)
    return withCloudinaryAccount(resourceType === 'image' ? 'image' : 'video', (cloudinary) => {
        const options = { resource_type: resourceType === 'raw' ? 'auto' : resourceType, ...(folder ? { folder } : {}) }
        if (buffer) {
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(options, (error, result) => (error ? reject(error) : resolve({ provider: 'cloudinary', ...result })))
                stream.end(buffer)
            })
        }
        return cloudinary.uploader.upload(filePath || sourceUrl, options).then((result) => ({ provider: 'cloudinary', ...result }))
    })
}

module.exports = { uploadUserMediaToDrive, storeMedia, guessMimeType }
