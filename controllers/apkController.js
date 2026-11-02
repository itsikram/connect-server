// Latest Android APK (admin → Settings → General). APKs are stored in the
// connected Google Drive accounts (admin → Google Drive) and served through
// /api/media. They never pass through this server's request body: Cloudflare
// rejects bodies over 100 MB and cuts responses slower than 100 s. So a file
// is uploaded by the browser straight to Google, and a link is copied by a
// background job the admin page polls.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { prisma } = require('../utils/db')
const {
    uploadToDrive,
    createResumableUpload,
    getDriveFileMeta,
    buildMediaUrl,
    parseDriveMediaUrl,
    deleteFromDrive,
} = require('../utils/googleDrive')
const { getEffectiveDriveConfig } = require('../utils/driveSettingsStore')

const APK_MIME = 'application/vnd.android.package-archive'
const MAX_APK_BYTES = 500 * 1024 * 1024
const URL_JOB_TIMEOUT_MS = 30 * 60 * 1000

// Same row connectController reads and updates
const findCurrent = () => prisma.connect.findFirst({ orderBy: { updatedAt: 'desc' } })

const apkName = (value) => {
    const base = path.basename(String(value || '')).replace(/[^\w.\- ()]/g, '_').trim()
    if (/\.apk$/i.test(base)) return base
    return `${base.replace(/\.[^.]*$/, '') || 'Connect'}.apk`
}

const httpError = (status, message) => Object.assign(new Error(message), { status })

const assertDriveConnected = async () => {
    const config = await getEffectiveDriveConfig()
    if (!config.clientId || !config.clientSecret || !config.accounts.some((a) => a.enabled)) {
        throw httpError(400, 'Connect a Google Drive account first (admin → Google Drive)')
    }
}

// Makes a stored Drive file the APK URL and removes the previous uploaded APK.
const setLatestApk = async (req, stored) => {
    const apkUrl = await buildMediaUrl(req, stored)
    const current = await findCurrent()
    const connect = current?.id
        ? await prisma.connect.update({ where: { id: current.id }, data: { apkUrl } })
        : await prisma.connect.create({ data: { apkUrl } })

    const previous = parseDriveMediaUrl(current?.apkUrl)
    if (previous && previous.fileId !== stored.fileId) {
        deleteFromDrive(previous.account, previous.fileId).catch((error) =>
            console.error('[apk] could not delete previous APK', { ...previous, error: error?.message || error }))
    }
    return connect
}

const sendApkError = (res, error, fallback) => {
    if (!error.status) console.error('[apk]', fallback, error?.message || error)
    return res.status(error.status || 502).json({ message: error?.message || fallback })
}

/** Step 1 of a file upload: a Google upload URL the browser PUTs the APK to. */
exports.startApkUpload = async (req, res) => {
    try {
        const name = String(req.body?.name || '')
        const size = Number(req.body?.size)
        if (!/\.apk$/i.test(name)) throw httpError(400, 'Only .apk files can be uploaded')
        if (!(size > 0)) throw httpError(400, 'The APK file is empty')
        if (size > MAX_APK_BYTES) throw httpError(400, 'The APK is larger than 500 MB')
        await assertDriveConnected()
        const session = await createResumableUpload({
            name: apkName(name),
            mimeType: APK_MIME,
            size,
            origin: req.get('Origin'),
        })
        return res.status(200).json(session)
    } catch (error) {
        return sendApkError(res, error, 'Could not start the APK upload')
    }
}

/** Step 2 of a file upload: the browser finished; make the file the APK URL. */
exports.finishApkUpload = async (req, res) => {
    try {
        const account = String(req.body?.account || '')
        const fileId = String(req.body?.fileId || '')
        if (!/^[a-z0-9_-]{10,}$/i.test(fileId)) throw httpError(400, 'Missing Drive file id')
        const meta = await getDriveFileMeta(account, fileId)
        if (!meta) throw httpError(404, 'Uploaded APK not found in Google Drive')
        if (!/\.apk$/i.test(meta.name || '')) throw httpError(400, 'Uploaded file is not an APK')
        return res.status(200).json(await setLatestApk(req, { account, fileId, name: meta.name }))
    } catch (error) {
        return sendApkError(res, error, 'Could not save the uploaded APK')
    }
}

// Copy-from-link job. One at a time; the admin page polls getApkJob.
let apkJob = { state: 'idle' }
const isJobRunning = () => apkJob.state === 'downloading' || apkJob.state === 'uploading'

// Google Drive share links open a web page; this is the file itself.
const toDirectDownloadUrl = (value) => {
    const url = new URL(value)
    if (/(^|\.)(drive|docs)\.google\.com$/i.test(url.hostname)) {
        const id = url.pathname.match(/\/file\/d\/([\w-]{10,})/)?.[1] || url.searchParams.get('id')
        if (id) return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
    }
    return url.toString()
}

const nameFromResponse = (response) => {
    const disposition = response.headers.get('content-disposition') || ''
    const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition) || /filename="?([^";]+)"?/i.exec(disposition)
    if (match) {
        try { return decodeURIComponent(match[1]) } catch (_) { return match[1] }
    }
    try { return decodeURIComponent(path.basename(new URL(response.url).pathname)) } catch (_) { return '' }
}

const runApkUrlJob = async (req, sourceUrl) => {
    const tempPath = path.join(os.tmpdir(), `connect-apk-${Date.now()}.part`)
    try {
        const response = await fetch(toDirectDownloadUrl(sourceUrl), {
            redirect: 'follow',
            signal: AbortSignal.timeout(URL_JOB_TIMEOUT_MS),
        })
        if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`)
        if (/text\/html/i.test(response.headers.get('content-type') || '')) {
            throw new Error('The link opened a web page, not an APK. For Google Drive, share the file as "Anyone with the link".')
        }
        const total = Number(response.headers.get('content-length')) || 0
        if (total > MAX_APK_BYTES) throw new Error('The APK is larger than 500 MB')
        const name = apkName(nameFromResponse(response))

        let written = 0
        const counter = new Transform({
            transform(chunk, _encoding, callback) {
                written += chunk.length
                if (written > MAX_APK_BYTES) return callback(new Error('The APK is larger than 500 MB'))
                if (total) apkJob.progress = Math.round((written / total) * 100)
                callback(null, chunk)
            },
        })
        await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(tempPath))

        // An APK is a zip archive
        const handle = await fs.promises.open(tempPath, 'r')
        const { buffer } = await handle.read(Buffer.alloc(4), 0, 4, 0)
        await handle.close()
        if (buffer.toString('binary') !== 'PK\x03\x04') throw new Error('The link did not return an APK file')

        apkJob = { ...apkJob, state: 'uploading', progress: 100, name, size: written }
        const stored = await uploadToDrive({ filePath: tempPath, size: written, mimeType: APK_MIME, name })
        const connect = await setLatestApk(req, { ...stored, name })
        apkJob = { ...apkJob, state: 'done', apkUrl: connect.apkUrl, finishedAt: Date.now() }
    } catch (error) {
        console.error('[apk] copy from link failed', error?.message || error)
        const message = error?.name === 'TimeoutError' ? 'Download timed out' : error?.message || 'Copy failed'
        apkJob = { ...apkJob, state: 'failed', message, finishedAt: Date.now() }
    } finally {
        fs.promises.unlink(tempPath).catch(() => {})
    }
}

/** Copies an APK from a link (direct or Google Drive share link) into Drive. */
exports.copyApkFromUrl = async (req, res) => {
    try {
        const url = String(req.body?.url || '').trim()
        if (!/^https?:\/\//i.test(url)) throw httpError(400, 'Enter an http(s) link to the APK')
        try { new URL(url) } catch (_) { throw httpError(400, 'That link is not valid') }
        if (isJobRunning()) throw httpError(409, 'An APK is already being copied')
        await assertDriveConnected()
        apkJob = { state: 'downloading', progress: 0, url, startedAt: Date.now() }
        runApkUrlJob(req, url)
        return res.status(202).json(apkJob)
    } catch (error) {
        return sendApkError(res, error, 'Could not start copying the APK')
    }
}

exports.getApkJob = (req, res) => res.set('Cache-Control', 'no-store').json(apkJob)
