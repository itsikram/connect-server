/**
 * Downloads/updates standalone yt-dlp binary (no Python required).
 * Always refreshes so Render/Docker builds pick up YouTube extractor fixes.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const BIN_DIR = path.join(__dirname, '..', 'bin');

const RELEASES = {
    linux: {
        url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
        filename: 'yt-dlp',
    },
    win32: {
        url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        filename: 'yt-dlp.exe',
    },
    darwin: {
        url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
        filename: 'yt-dlp',
    },
};

const downloadFile = (url, dest) =>
    new Promise((resolve, reject) => {
        const request = (targetUrl) => {
            https.get(targetUrl, { headers: { 'User-Agent': 'Connect-Server' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    request(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed (${res.statusCode}): ${targetUrl}`));
                    return;
                }
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', reject);
            }).on('error', reject);
        };
        request(url);
    });

async function main() {
    const force = process.argv.includes('--force') || process.env.YT_DLP_FORCE_UPDATE === 'true';
    const spec = RELEASES[process.platform];
    if (!spec) {
        console.log(`[install-yt-dlp] Skip: unsupported platform ${process.platform}`);
        return;
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    const dest = path.join(BIN_DIR, spec.filename);
    const tmp = `${dest}.tmp`;

    // Always refresh on CI/Render/Docker builds so YouTube fixes ship.
    const shouldRefresh =
        force ||
        !fs.existsSync(dest) ||
        process.env.RENDER === 'true' ||
        process.env.YT_DLP_FORCE_UPDATE === 'true' ||
        fs.existsSync('/.dockerenv');

    if (!shouldRefresh) {
        console.log(`[install-yt-dlp] Already installed: ${dest}`);
        return;
    }

    console.log(`[install-yt-dlp] Downloading ${spec.url}`);
    try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        await downloadFile(spec.url, tmp);
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        fs.renameSync(tmp, dest);
        if (process.platform !== 'win32') {
            fs.chmodSync(dest, 0o755);
        }
        console.log(`[install-yt-dlp] Installed/updated: ${dest}`);
    } catch (err) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        if (fs.existsSync(dest)) {
            console.warn(`[install-yt-dlp] Update failed, keeping existing binary: ${err.message}`);
            return;
        }
        throw err;
    }
}

main().catch((err) => {
    console.error('[install-yt-dlp] Failed:', err.message);
    process.exit(0);
});
