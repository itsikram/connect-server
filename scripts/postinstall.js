/**
 * Safe postinstall wrapper — skips yt-dlp install if script not copied yet (Docker layer caching).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const script = path.join(__dirname, 'install-yt-dlp.js');

if (!fs.existsSync(script)) {
    console.log('[postinstall] install-yt-dlp.js not found yet, skipping');
    process.exit(0);
}

try {
    execSync(`node "${script}"`, { stdio: 'inherit' });
} catch (err) {
    console.warn('[postinstall] yt-dlp install failed (non-fatal):', err.message || err);
    process.exit(0);
}
