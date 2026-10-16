const { Readable } = require('stream')
const { drive: createDrive, auth: driveAuth } = require('@googleapis/drive')

// User uploads can be stored across several Google Drive accounts. Each
// account is a personal Google account that granted this app the
// `drive.file` scope (see scripts/gdrive-auth.js). Files are served back
// through /api/media/:account/:fileId so clients get a normal URL.
//
// GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET: OAuth client (Desktop app type)
// GDRIVE_ACCOUNTS: comma separated "name:refreshToken" pairs
// GDRIVE_FOLDER_NAME: folder created in each account (default connect-uploads)
// MEDIA_STORAGE=gdrive switches user uploads from Cloudinary to Drive

const FOLDER_NAME = process.env.GDRIVE_FOLDER_NAME || 'connect-uploads'
const QUOTA_TTL_MS = 5 * 60 * 1000

let accountsCache = null

const parseAccounts = () => {
    const raw = String(process.env.GDRIVE_ACCOUNTS || '').trim()
    if (!raw) return []
    return raw.split(',').map((entry) => {
        const index = entry.indexOf(':')
        if (index < 1) return null
        const name = entry.slice(0, index).trim()
        const refreshToken = entry.slice(index + 1).trim()
        if (!/^[a-z0-9_-]+$/i.test(name) || !refreshToken) return null
        return { name, refreshToken }
    }).filter(Boolean)
}

const getAccounts = () => {
    if (accountsCache) return accountsCache
    const clientId = process.env.GDRIVE_CLIENT_ID
    const clientSecret = process.env.GDRIVE_CLIENT_SECRET
    if (!clientId || !clientSecret) return []

    accountsCache = parseAccounts().map(({ name, refreshToken }) => {
        const client = new driveAuth.OAuth2(clientId, clientSecret)
        client.setCredentials({ refresh_token: refreshToken })
        return {
            name,
            drive: createDrive({ version: 'v3', auth: client }),
            folderId: null,
            quota: null,
            quotaCheckedAt: 0,
            full: false,
        }
    })
    return accountsCache
}

const isDriveStorageEnabled = () =>
    String(process.env.MEDIA_STORAGE || '').toLowerCase() === 'gdrive' && getAccounts().length > 0

const getAccount = (name) => getAccounts().find((account) => account.name === name) || null

const refreshQuota = async (account) => {
    if (account.quota && Date.now() - account.quotaCheckedAt < QUOTA_TTL_MS) return account.quota
    const { data } = await account.drive.about.get({ fields: 'storageQuota' })
    const limit = Number(data.storageQuota?.limit || 0)
    const usage = Number(data.storageQuota?.usage || 0)
    // No limit means unlimited storage (some Workspace plans)
    account.quota = { limit, usage, free: limit ? limit - usage : Number.MAX_SAFE_INTEGER }
    account.quotaCheckedAt = Date.now()
    account.full = false
    return account.quota
}

const ensureFolder = async (account) => {
    if (account.folderId) return account.folderId
    const escaped = FOLDER_NAME.replace(/'/g, "\\'")
    const { data } = await account.drive.files.list({
        q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        spaces: 'drive',
        pageSize: 1,
    })
    if (data.files?.length) {
        account.folderId = data.files[0].id
        return account.folderId
    }
    const created = await account.drive.files.create({
        requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
    })
    account.folderId = created.data.id
    return account.folderId
}

// Accounts with the most free space first, skipping ones that cannot hold the file
const pickAccounts = async (size) => {
    const accounts = getAccounts()
    const ranked = await Promise.all(accounts.map(async (account) => {
        try {
            const quota = await refreshQuota(account)
            return { account, free: quota.free }
        } catch (error) {
            console.error('[gdrive] quota check failed', { account: account.name, error: error?.message || error })
            return { account, free: -1 }
        }
    }))
    return ranked
        .filter(({ account, free }) => !account.full && free > size)
        .sort((a, b) => b.free - a.free)
        .map(({ account }) => account)
}

const isQuotaError = (error) => {
    const reasons = (error?.errors || error?.response?.data?.error?.errors || []).map((e) => e.reason)
    return reasons.includes('storageQuotaExceeded') || /storage quota/i.test(String(error?.message || ''))
}

const uploadToDrive = async ({ buffer, mimeType, name }) => {
    const candidates = await pickAccounts(buffer.length)
    if (!candidates.length) {
        const error = new Error('No Google Drive account has enough free space for this upload')
        error.code = 'MEDIA_STORAGE_FULL'
        throw error
    }

    let lastError
    for (const account of candidates) {
        try {
            const folderId = await ensureFolder(account)
            const { data } = await account.drive.files.create({
                requestBody: { name, parents: [folderId] },
                media: { mimeType, body: Readable.from(buffer) },
                fields: 'id,name,mimeType,size',
            })
            if (account.quota) {
                account.quota.usage += buffer.length
                account.quota.free -= buffer.length
            }
            return { account: account.name, fileId: data.id, name: data.name, mimeType: data.mimeType, size: Number(data.size || buffer.length) }
        } catch (error) {
            lastError = error
            if (isQuotaError(error)) {
                account.full = true
                continue
            }
            throw error
        }
    }
    throw lastError
}

// Returns the Drive response stream for a file, honouring an optional Range header
const getDriveFileStream = async (accountName, fileId, range) => {
    const account = getAccount(accountName)
    if (!account) return null
    return account.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream', headers: range ? { Range: range } : {}, validateStatus: (status) => status < 500 },
    )
}

const getDriveFileMeta = async (accountName, fileId) => {
    const account = getAccount(accountName)
    if (!account) return null
    const { data } = await account.drive.files.get({ fileId, fields: 'id,name,mimeType,size' })
    return data
}

const deleteFromDrive = async (accountName, fileId) => {
    const account = getAccount(accountName)
    if (!account) return { result: 'unknown account' }
    try {
        await account.drive.files.delete({ fileId })
        account.quotaCheckedAt = 0
        return { result: 'ok' }
    } catch (error) {
        if (error?.code === 404 || error?.response?.status === 404) return { result: 'not found' }
        throw error
    }
}

// Matches URLs produced by buildMediaUrl on any host
const MEDIA_PATH_RE = /\/api\/media\/([a-z0-9_-]+)\/([a-z0-9_-]{10,})(?:\/|$|\?)/i

const parseDriveMediaUrl = (value) => {
    if (typeof value !== 'string') return null
    const match = value.match(MEDIA_PATH_RE)
    return match ? { account: match[1], fileId: match[2] } : null
}

const buildMediaUrl = (req, { account, fileId, name }) => {
    const base = (process.env.MEDIA_PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')
    const safeName = encodeURIComponent(String(name || 'file').replace(/[\\/]/g, '_'))
    return `${base}/api/media/${account}/${fileId}/${safeName}`
}

const getDriveStorageStatus = async () => Promise.all(getAccounts().map(async (account) => {
    try {
        const quota = await refreshQuota(account)
        return { name: account.name, ...quota }
    } catch (error) {
        return { name: account.name, error: error?.message || String(error) }
    }
}))

module.exports = {
    isDriveStorageEnabled,
    uploadToDrive,
    getDriveFileStream,
    getDriveFileMeta,
    deleteFromDrive,
    parseDriveMediaUrl,
    buildMediaUrl,
    getDriveStorageStatus,
}
