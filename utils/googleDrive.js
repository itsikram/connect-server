const { Readable } = require('stream')
const { drive: createDrive, auth: driveAuth } = require('@googleapis/drive')

const { getEffectiveDriveConfig } = require('./driveSettingsStore')

// User uploads can be stored across several Google Drive accounts. Each
// account is a personal Google account that granted this app the
// `drive.file` scope. Files are served back through
// /api/media/:account/:fileId so clients get a normal URL.
//
// Accounts, the OAuth client and the on/off switch are managed from the
// admin panel (utils/driveSettingsStore.js). The env variables below still
// work as defaults:
// GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET: OAuth client
// GDRIVE_ACCOUNTS: comma separated "name:refreshToken" pairs
// GDRIVE_FOLDER_NAME: folder created in each account (default connect-uploads)
// MEDIA_STORAGE=gdrive switches user uploads from Cloudinary to Drive

const FOLDER_NAME = process.env.GDRIVE_FOLDER_NAME || 'connect-uploads'
const QUOTA_TTL_MS = 5 * 60 * 1000

// Drive clients by client id + account + token, kept across settings reloads
// so folder ids and quota stay cached for unchanged accounts
const clients = new Map()

const createOAuthClient = (clientId, clientSecret, redirectUri) =>
    new driveAuth.OAuth2(clientId, clientSecret, redirectUri)

const getAccounts = async () => {
    const config = await getEffectiveDriveConfig()
    if (!config.clientId || !config.clientSecret) return []
    return config.accounts.map(({ name, refreshToken, enabled, email, source }) => {
        const key = `${config.clientId}|${name}|${refreshToken}`
        let account = clients.get(key)
        if (!account) {
            const client = createOAuthClient(config.clientId, config.clientSecret)
            client.setCredentials({ refresh_token: refreshToken })
            account = {
                name,
                drive: createDrive({ version: 'v3', auth: client }),
                folderId: null,
                quota: null,
                quotaCheckedAt: 0,
                full: false,
            }
            clients.set(key, account)
        }
        return Object.assign(account, { enabled, email, source })
    })
}

const isDriveStorageEnabled = async () => {
    const config = await getEffectiveDriveConfig()
    return config.enabled && Boolean(config.clientId && config.clientSecret) && config.accounts.some((a) => a.enabled)
}

// Disabled accounts still serve and delete their existing files
const getAccount = async (name) => (await getAccounts()).find((account) => account.name === name) || null

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

// Short reason Google gave for a failure, e.g. "invalid_grant: Token has been expired or revoked."
const getGoogleErrorReason = (error) => {
    const data = error?.response?.data
    if (data && typeof data.error === 'string') {
        return data.error_description ? `${data.error}: ${data.error_description}` : data.error
    }
    return data?.error?.message || error?.message || String(error)
}

// Accounts with the most free space first, skipping ones that cannot hold the file.
// `failures` lists accounts whose quota could not be read (bad credentials, network).
const pickAccounts = async (size) => {
    const accounts = (await getAccounts()).filter((account) => account.enabled)
    const failures = []
    const ranked = await Promise.all(accounts.map(async (account) => {
        try {
            const quota = await refreshQuota(account)
            return { account, free: quota.free }
        } catch (error) {
            const reason = getGoogleErrorReason(error)
            console.error('[gdrive] quota check failed', { account: account.name, error: reason })
            failures.push({ account: account.name, reason })
            return { account, free: -1 }
        }
    }))
    const candidates = ranked
        .filter(({ account, free }) => !account.full && free > size)
        .sort((a, b) => b.free - a.free)
        .map(({ account }) => account)
    return { candidates, failures }
}

const isQuotaError = (error) => {
    const reasons = (error?.errors || error?.response?.data?.error?.errors || []).map((e) => e.reason)
    return reasons.includes('storageQuotaExceeded') || /storage quota/i.test(String(error?.message || ''))
}

const uploadToDrive = async ({ buffer, mimeType, name }) => {
    const { candidates, failures } = await pickAccounts(buffer.length)
    if (!candidates.length) {
        // Only call it full when every account answered; otherwise Google rejected us
        const unreachable = failures.length > 0
        const error = new Error(unreachable
            ? `Google Drive unavailable: ${failures.map((f) => `${f.account} (${f.reason})`).join(', ')}`
            : 'No Google Drive account has enough free space for this upload')
        error.code = unreachable ? 'MEDIA_STORAGE_UNAVAILABLE' : 'MEDIA_STORAGE_FULL'
        error.failures = failures
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
    const account = await getAccount(accountName)
    if (!account) return null
    return account.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream', headers: range ? { Range: range } : {}, validateStatus: (status) => status < 500 },
    )
}

const getDriveFileMeta = async (accountName, fileId) => {
    const account = await getAccount(accountName)
    if (!account) return null
    const { data } = await account.drive.files.get({ fileId, fields: 'id,name,mimeType,size' })
    return data
}

const deleteFromDrive = async (accountName, fileId) => {
    const account = await getAccount(accountName)
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

const buildMediaUrl = async (req, { account, fileId, name }) => {
    const { publicBaseUrl } = await getEffectiveDriveConfig()
    const base = (publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')
    const safeName = encodeURIComponent(String(name || 'file').replace(/[\\/]/g, '_'))
    return `${base}/api/media/${account}/${fileId}/${safeName}`
}

const getDriveStorageStatus = async () => Promise.all((await getAccounts()).map(async (account) => {
    try {
        const quota = await refreshQuota(account)
        return { name: account.name, email: account.email, enabled: account.enabled, source: account.source, ...quota }
    } catch (error) {
        return { name: account.name, email: account.email, enabled: account.enabled, source: account.source, error: getGoogleErrorReason(error) }
    }
}))

module.exports = {
    createOAuthClient,
    createDrive,
    getGoogleErrorReason,
    isDriveStorageEnabled,
    uploadToDrive,
    getDriveFileStream,
    getDriveFileMeta,
    deleteFromDrive,
    parseDriveMediaUrl,
    buildMediaUrl,
    getDriveStorageStatus,
}
