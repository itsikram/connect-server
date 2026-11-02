const { prisma } = require('../utils/db')
// Mongoose ignored unknown keys; Prisma rejects them, so keep only real columns.
const { Prisma } = require('@prisma/client')
const CONNECT_FIELDS = Object.keys(Prisma.ConnectScalarFieldEnum).filter(
    (key) => !['id', 'createdAt', 'updatedAt'].includes(key)
)
const connectData = (body = {}) => {
    const data = {}
    for (const key of CONNECT_FIELDS) {
        if (body && body[key] !== undefined) data[key] = body[key]
    }
    return data
}

// Admin saves used to add a new row each time (they checked the Mongo-era
// `_id`, which Prisma rows do not have), so read and update the newest row:
// that is the one holding the admin's latest settings (APK URL, version...).
const findCurrent = () => prisma.connect.findFirst({ orderBy: { updatedAt: 'desc' } })

exports.getData=async(req,res,next)=>{
    let connect = await findCurrent()
    if(connect) {
        return res.json(connect).status(200)
    }
    return res.json({message: 'Connect data not found'}).status(404)
}

exports.updateData=async(req,res,next)=>{
    let connect = await findCurrent()
    if(connect?.id) {
        let updatedConnect = await prisma.connect.update({ where: { id: connect.id }, data: connectData(req.body) })
        if(updatedConnect) {
            return res.json(updatedConnect).status(200)
        }
    }else {
        let connect = await prisma.connect.create({ data: connectData(req.body) })
        if(connect) {
            return res.json(connect).status(200)
        }
    }
    return res.json({message: 'Connect data not found'}).status(404)

}

const fs = require('fs')
const { uploadToDrive, buildMediaUrl, parseDriveMediaUrl, deleteFromDrive } = require('../utils/googleDrive')
const { getEffectiveDriveConfig } = require('../utils/driveSettingsStore')

// Admin → Settings → General → Upload APK. Stores the APK in the connected
// Google Drive accounts (admin → Google Drive) and makes it the APK URL that
// Android apps update from; the previous uploaded APK is removed from Drive.
exports.uploadApk = async (req, res) => {
    const file = req.file
    try {
        if (!file) return res.status(400).json({ message: 'Choose an APK file to upload' })
        if (!/\.apk$/i.test(file.originalname || '')) {
            return res.status(400).json({ message: 'Only .apk files can be uploaded' })
        }
        const driveConfig = await getEffectiveDriveConfig()
        if (!driveConfig.clientId || !driveConfig.clientSecret || !driveConfig.accounts.some((a) => a.enabled)) {
            return res.status(400).json({ message: 'Connect a Google Drive account first (admin → Google Drive)' })
        }

        const name = String(file.originalname).replace(/[\/]/g, '_')
        const stored = await uploadToDrive({
            filePath: file.path,
            size: file.size,
            mimeType: 'application/vnd.android.package-archive',
            name,
        })
        const apkUrl = await buildMediaUrl(req, { ...stored, name })

        const current = await findCurrent()
        const connect = current?.id
            ? await prisma.connect.update({ where: { id: current.id }, data: { apkUrl } })
            : await prisma.connect.create({ data: { apkUrl } })

        const previous = parseDriveMediaUrl(current?.apkUrl)
        if (previous && previous.fileId !== stored.fileId) {
            deleteFromDrive(previous.account, previous.fileId).catch((error) =>
                console.error('[apk] could not delete previous APK', { ...previous, error: error?.message || error }))
        }
        return res.status(200).json(connect)
    } catch (error) {
        console.error('[apk] upload failed', error?.message || error)
        return res.status(502).json({ message: error?.message || 'APK upload failed' })
    } finally {
        if (file?.path) fs.promises.unlink(file.path).catch(() => {})
    }
}
