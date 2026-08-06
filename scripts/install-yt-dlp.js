/**
 * Downloads standalone yt-dlp binary (no Python required).
 * Used on Render where system Python is 3.9 but yt-dlp needs 3.10+.
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
    const spec = RELEASES[process.platform];
    if (!spec) {
        console.log(`[install-yt-dlp] Skip: unsupported platform ${process.platform}`);
        return;
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    const dest = path.join(BIN_DIR, spec.filename);

    if (fs.existsSync(dest)) {
        console.log(`[install-yt-dlp] Already installed: ${dest}`);
        return;
    }

    console.log(`[install-yt-dlp] Downloading ${spec.url}`);
    await downloadFile(spec.url, dest);

    if (process.platform !== 'win32') {
        fs.chmodSync(dest, 0o755);
    }

    console.log(`[install-yt-dlp] Installed: ${dest}`);
}

main().catch((err) => {
    console.error('[install-yt-dlp] Failed:', err.message);
    process.exit(0);
});
