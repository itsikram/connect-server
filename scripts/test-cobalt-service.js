/**
 * Test Connect download service Cobalt path (no HTTP server needed).
 * Usage: node scripts/test-cobalt-service.js [youtube-url]
 */
require('dotenv').config({ override: true });
const path = require('path');

// Force local Cobalt unless argv[3] overrides
if (process.argv[3]) {
    process.env.COBALT_API_URL = process.argv[3];
} else if (!process.env.COBALT_API_URL || process.env.COBALT_API_URL.includes('onrender.com')) {
    process.env.COBALT_API_URL = 'http://127.0.0.1:9000';
}
process.env.YT_DL_PREFER_COBALT = 'true';
process.env.YT_DL_COBALT_ONLY = 'true';

const url = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

async function main() {
    // Fresh load so env above applies
    const svcPath = path.join(__dirname, '..', 'services', 'ytDownloadService.js');
    delete require.cache[require.resolve(svcPath)];
    const mod = require(svcPath);

    console.log('Cobalt URL:', process.env.COBALT_API_URL);
    console.log('Video:', url);
    console.log('Mode: YT_DL_COBALT_ONLY=true');

    const poll = setInterval(() => {
        const p = mod.getProgress(progressId);
        if (p && p.status === 'running') {
            process.stdout.write(`\r${p.stage} ${p.pct}% source=${p.source || '-'}`);
        }
    }, 500);

    const progressId = mod.startDownloadJob({
        baseUrl: 'http://127.0.0.1:4000',
        url,
        height: 360,
        postAsWatch: false,
        profileId: null,
    });
    console.log('Progress ID:', progressId);

    for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const p = mod.getProgress(progressId);
        if (!p) continue;
        if (p.status === 'completed') {
            clearInterval(poll);
            console.log('\nSUCCESS');
            console.log('Title:', p.title);
            console.log('Source:', p.source);
            console.log('File URL:', p.file_url);
            process.exit(0);
        }
        if (p.status === 'failed') {
            clearInterval(poll);
            throw new Error(p.error || 'Download failed');
        }
    }
    clearInterval(poll);
    throw new Error('Timed out');
}

main().catch((e) => {
    console.error('\nFAILED:', e.message);
    process.exit(1);
});
