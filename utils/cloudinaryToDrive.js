// Moves every Cloudinary file the database still links to into Google Drive,
// then rewrites those links to the Drive-served /api/media/... URLs.
//
// - Runs on a live server (it needs the live database and Drive accounts),
//   started from the admin panel: POST /api/admin/media/migrate-to-drive.
// - Every copied file is recorded in the `cloudinary_drive_map` table, so a
//   restarted or repeated run skips files already copied and only finishes the rest.
// - Cloudinary files are never deleted here; they stay as a backup.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const axios = require('axios')
const { prisma } = require('./db')
const { allTextRows } = require('./dbTextScan')
const { uploadToDrive, resolveMediaBase, mediaUrlFor, isDriveStorageEnabled, listAppFiles, deleteFromDrive, parseDriveMediaUrl } = require('./googleDrive')
const { guessMimeType } = require('./mediaStorage')

const CLOUDINARY_URL_RE = /https?:\/\/(?:res\.cloudinary\.com|[a-z0-9-]+\.res\.cloudinary\.com)\/[^\s"'<>()\\]+/gi
const CONCURRENCY = Math.max(1, Number(process.env.CLOUDINARY_DRIVE_MIGRATION_CONCURRENCY || 3))
const TEMP_DIR = path.join(os.tmpdir(), 'connect-cloudinary-to-drive')

let tableReady = null
const ensureTable = () => {
    if (!tableReady) {
        tableReady = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS \`cloudinary_drive_map\` (
            \`hash\` CHAR(40) NOT NULL,
            \`sourceUrl\` TEXT NOT NULL,
            \`driveUrl\` VARCHAR(1024) NULL,
            \`bytes\` BIGINT NULL,
            \`status\` VARCHAR(16) NOT NULL,
            \`error\` VARCHAR(512) NULL,
            \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (\`hash\`)
        ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`).catch((error) => {
            tableReady = null
            throw error
        })
    }
    return tableReady
}

const hashUrl = (url) => crypto.createHash('sha1').update(url).digest('hex')

// Trailing punctuation from text like "see https://...jpg." is not part of the URL
const cleanUrl = (url) => url.replace(/[.,;:!?\]}]+$/, '')

const findUrls = (value, found) => {
    if (typeof value === 'string') {
        if (value.includes('cloudinary.com')) {
            for (const match of value.matchAll(CLOUDINARY_URL_RE)) found.add(cleanUrl(match[0]))
        }
    } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) findUrls(child, found)
    }
}

const replaceUrls = (value, mapping) => {
    if (typeof value === 'string') {
        if (!value.includes('cloudinary.com')) return { value, count: 0 }
        let count = 0
        const next = value.replace(CLOUDINARY_URL_RE, (match) => {
            const url = cleanUrl(match)
            const target = mapping.get(url)
            if (!target) return match
            count += 1
            return target + match.slice(url.length)
        })
        return { value: next, count }
    }
    if (!value || typeof value !== 'object') return { value, count: 0 }
    let count = 0
    const next = Array.isArray(value) ? [] : {}
    for (const [key, child] of Object.entries(value)) {
        const result = replaceUrls(child, mapping)
        next[key] = result.value
        count += result.count
    }
    return { value: next, count }
}

const loadMapping = async () => {
    await ensureTable()
    const rows = await prisma.$queryRawUnsafe('SELECT `sourceUrl`, `driveUrl`, `status` FROM `cloudinary_drive_map`')
    return new Map(rows.map((row) => [row.sourceUrl, row]))
}

const saveMapping = (url, data) => prisma.$executeRawUnsafe(
    'INSERT INTO `cloudinary_drive_map` (`hash`, `sourceUrl`, `driveUrl`, `bytes`, `status`, `error`, `updatedAt`) VALUES (?, ?, ?, ?, ?, ?, NOW(3)) ' +
    'ON DUPLICATE KEY UPDATE `driveUrl` = VALUES(`driveUrl`), `bytes` = VALUES(`bytes`), `status` = VALUES(`status`), `error` = VALUES(`error`), `updatedAt` = NOW(3)',
    hashUrl(url), url, data.driveUrl || null, data.bytes || null, data.status, data.error ? String(data.error).slice(0, 500) : null,
)

const fileNameFromUrl = (url) => {
    try {
        const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file')
        return last.replace(/[^a-z0-9._-]/gi, '_').slice(-80) || 'file'
    } catch {
        return 'file'
    }
}

const copyOne = async (url, base) => {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
    const tempPath = path.join(TEMP_DIR, `${crypto.randomUUID()}.bin`)
    try {
        const response = await axios.get(url, { responseType: 'stream', timeout: 0, validateStatus: () => true })
        // 401/403: the Cloudinary account no longer serves it (e.g. an old or closed account)
        if ([401, 403, 404, 410].includes(response.status)) {
            response.data.resume()
            return { status: 'missing', error: `Cloudinary returned HTTP ${response.status}` }
        }
        if (response.status >= 400) {
            response.data.resume()
            throw new Error(`Cloudinary returned HTTP ${response.status}`)
        }
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tempPath)
            response.data.on('error', reject)
            out.on('error', reject)
            out.on('finish', resolve)
            response.data.pipe(out)
        })
        const size = (await fs.promises.stat(tempPath)).size
        const name = fileNameFromUrl(url)
        const headerType = String(response.headers['content-type'] || '').split(';')[0].trim()
        const mimeType = headerType && headerType !== 'application/octet-stream' ? headerType : guessMimeType(name)
        const stored = await uploadToDrive({ filePath: tempPath, size, mimeType, name: `migrated-${Date.now()}-${name}` })
        const driveUrl = mediaUrlFor(base, stored)
        return { status: 'done', driveUrl, bytes: size }
    } finally {
        fs.promises.unlink(tempPath).catch(() => {})
    }
}

// Files named migrated-* that no recorded copy points to
const removeOrphans = async (mapping, state) => {
    const recorded = new Set()
    for (const row of mapping.values()) {
        const parsed = row.status === 'done' && parseDriveMediaUrl(row.driveUrl)
        if (parsed) recorded.add(`${parsed.account}:${parsed.fileId}`)
    }
    let removed = 0
    for (const file of await listAppFiles('migrated-')) {
        if (!file.name.startsWith('migrated-') || recorded.has(`${file.account}:${file.fileId}`)) continue
        try {
            await deleteFromDrive(file.account, file.fileId)
            removed += 1
        } catch (error) {
            if (state.errors.length < 50) state.errors.push({ reason: `Could not remove unlinked copy ${file.name}: ${error?.message || error}` })
        }
    }
    return removed
}

let job = null

const getMigrationStatus = () => job

/** Starts the migration in the background. dryRun only counts the files to move. */
const startMigration = async ({ dryRun = false, baseUrl = null } = {}) => {
    if (job && !job.finishedAt) {
        const error = new Error('A migration is already running')
        error.status = 409
        throw error
    }
    if (!dryRun && !(await isDriveStorageEnabled())) {
        const error = new Error('Turn on Google Drive storage (with at least one account) before moving files')
        error.status = 400
        throw error
    }
    await ensureTable()
    // Resolve the link address up front: no file is uploaded if links cannot be built
    const base = dryRun ? null : await resolveMediaBase(baseUrl)

    job = {
        id: crypto.randomUUID(),
        dryRun,
        phase: 'scanning',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        rowsScanned: 0,
        found: 0,
        alreadyCopied: 0,
        toCopy: 0,
        copied: 0,
        missing: 0,
        failed: 0,
        orphansRemoved: 0,
        bytesCopied: 0,
        rowsUpdated: 0,
        linksUpdated: 0,
        errors: [],
    }
    const current = job
    run(current, base).catch((error) => {
        current.phase = 'failed'
        current.errors.push({ reason: error?.message || String(error) })
        current.finishedAt = new Date().toISOString()
        console.error('[cloudinary->drive] migration failed', error)
    })
    return current
}

const run = async (state, base) => {
    // 1. Find every Cloudinary URL in the database
    const found = new Set()
    for await (const { model, row } of allTextRows()) {
        state.rowsScanned += 1
        for (const column of model.columns) findUrls(row[column.name], found)
    }
    state.found = found.size

    const mapping = await loadMapping()
    // Files copied before, or already known to be gone from Cloudinary, are skipped
    const pending = [...found].filter((url) => !['done', 'missing'].includes(mapping.get(url)?.status))
    state.alreadyCopied = [...found].filter((url) => mapping.get(url)?.status === 'done').length
    state.toCopy = pending.length

    if (state.dryRun) {
        state.phase = 'done'
        state.finishedAt = new Date().toISOString()
        return
    }

    // 2. Remove Drive copies an earlier run uploaded but never recorded (they were
    //    never linked anywhere), so retries do not leave duplicates behind
    state.phase = 'cleaning'
    state.orphansRemoved = await removeOrphans(mapping, state)

    // 3. Copy each file to Drive (a few at a time), recording each copy
    state.phase = 'copying'
    let index = 0
    const worker = async () => {
        while (index < pending.length) {
            const url = pending[index++]
            try {
                const result = await copyOne(url, base)
                await saveMapping(url, result)
                if (result.status === 'done') {
                    state.copied += 1
                    state.bytesCopied += result.bytes
                } else {
                    state.missing += 1
                }
            } catch (error) {
                state.failed += 1
                if (state.errors.length < 50) state.errors.push({ url, reason: error?.message || String(error) })
                await saveMapping(url, { status: 'failed', error: error?.message || String(error) }).catch(() => {})
                // Stop when Drive itself is full or unreachable instead of failing every file
                if (error?.code === 'MEDIA_STORAGE_FULL' || error?.code === 'MEDIA_STORAGE_UNAVAILABLE') {
                    index = pending.length
                    throw error
                }
            }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))

    // 4. Point the database at the Drive copies
    state.phase = 'rewriting'
    const done = new Map()
    for (const [url, row] of await loadMapping()) {
        if (row.status === 'done' && row.driveUrl) done.set(url, row.driveUrl)
    }
    for await (const { model, row } of allTextRows()) {
        const updates = {}
        let links = 0
        for (const column of model.columns) {
            const result = replaceUrls(row[column.name], done)
            if (result.count) {
                updates[column.name] = result.value
                links += result.count
            }
        }
        if (!links) continue
        try {
            await model.delegate.update({ where: { id: row.id }, data: updates })
            state.rowsUpdated += 1
            state.linksUpdated += links
        } catch (error) {
            if (state.errors.length < 50) state.errors.push({ table: model.name, id: row.id, reason: error?.message || String(error) })
        }
    }

    state.phase = 'done'
    state.finishedAt = new Date().toISOString()
    console.log('[cloudinary->drive] migration finished', {
        copied: state.copied, missing: state.missing, failed: state.failed, linksUpdated: state.linksUpdated,
    })
}

module.exports = { startMigration, getMigrationStatus, findUrls, replaceUrls, CLOUDINARY_URL_RE }
