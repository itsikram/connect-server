const Router = require('express').Router()
const { getDriveFileStream, getDriveFileMeta } = require('../utils/googleDrive')

// Streams files stored in Google Drive. Public like Cloudinary URLs were:
// the Drive file id is unguessable and only files this app created are reachable.
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']

const serveMedia = async (req, res) => {
    const { account, fileId } = req.params
    if (!/^[a-z0-9_-]{10,}$/i.test(fileId)) return res.status(404).end()

    try {
        if (req.method === 'HEAD') {
            const meta = await getDriveFileMeta(account, fileId)
            if (!meta) return res.status(404).end()
            res.set({
                'Content-Type': meta.mimeType || 'application/octet-stream',
                'Content-Length': meta.size,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=31536000, immutable',
            })
            return res.status(200).end()
        }

        const upstream = await getDriveFileStream(account, fileId, req.headers.range)
        if (!upstream) return res.status(404).end()
        if (upstream.status >= 400) {
            upstream.data.resume()
            return res.status(upstream.status === 416 ? 416 : 404).end()
        }

        // Newer Drive clients return a fetch Headers object instead of a plain object
        const upstreamHeaders = upstream.headers || {}
        const readHeader = (name) => typeof upstreamHeaders.get === 'function' ? upstreamHeaders.get(name) : upstreamHeaders[name]
        for (const header of PASS_HEADERS) {
            const value = readHeader(header)
            if (value) res.setHeader(header, value)
        }
        if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.status(upstream.status)

        req.on('close', () => upstream.data.destroy())
        upstream.data.on('error', (error) => {
            console.error('[media] stream failed', { account, fileId, error: error?.message || error })
            res.destroy(error)
        })
        upstream.data.pipe(res)
    } catch (error) {
        const status = error?.code === 404 || error?.response?.status === 404 ? 404 : 502
        if (status !== 404) console.error('[media] fetch failed', { account, fileId, error: error?.message || error })
        if (!res.headersSent) res.status(status).end()
    }
}

Router.get('/:account/:fileId/:name?', serveMedia)
Router.head('/:account/:fileId/:name?', serveMedia)

module.exports = Router
