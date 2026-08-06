/**
 * Verify live Cobalt + yt-session, then download a YouTube video.
 * Usage: node scripts/verify-live-cobalt.js [youtube-url]
 */
require('dotenv').config({ override: true });
const path = require('path');
const os = require('os');
const fs = require('fs');
const axios = require('axios');

const SESSION_URL = process.env.YOUTUBE_SESSION_SERVER || 'https://yt-session-75x3.onrender.com';
const COBALT_URL = process.env.COBALT_API_URL || 'https://cobalt-yt.onrender.com';
const VIDEO = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForToken(maxAttempts = 40) {
    const tokenUrl = SESSION_URL.replace(/\/$/, '') + '/token';
    console.log('Waiting for yt-session token:', tokenUrl);
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            const res = await axios.get(tokenUrl, { timeout: 30000, validateStatus: () => true });
            if (res.status === 200 && res.data && (res.data.potoken || res.data.poToken)) {
                console.log(`Token ready (attempt ${i}) len=${String(res.data.potoken || res.data.poToken).length}`);
                return res.data;
            }
            console.log(`attempt ${i}/${maxAttempts}: HTTP ${res.status} ${typeof res.data === 'string' ? res.data.slice(0, 60) : 'no potoken yet'}`);
        } catch (e) {
            console.log(`attempt ${i}/${maxAttempts}: ${e.message}`);
        }
        await sleep(15000);
    }
    throw new Error('yt-session never produced a poToken');
}

async function testCobalt() {
    const { downloadViaCobalt } = require('../services/ytCobaltFallback');
    const outDir = path.join(os.tmpdir(), 'connect-yt-downloads');
    fs.mkdirSync(outDir, { recursive: true });
    const prefix = `verify-${Date.now()}`;
    console.log('Cobalt download via', COBALT_URL);
    const result = await downloadViaCobalt({
        url: VIDEO,
        height: 360,
        outputDir: outDir,
        outputPrefix: prefix,
        onProgress: (p) => process.stdout.write(`\r${p}% `),
    });
    const size = fs.statSync(result.filePath).size;
    console.log('\nCobalt SUCCESS', result.title, size, 'bytes');
    if (size < 1000) throw new Error('file too small');
    return result;
}

async function main() {
    process.env.COBALT_API_URL = COBALT_URL;
    console.log('=== 1) yt-session health ===');
    const health = await axios.get(SESSION_URL.replace(/\/$/, '') + '/health', { timeout: 30000, validateStatus: () => true });
    console.log('health', health.status, health.data);

    console.log('=== 2) wait for poToken ===');
    await waitForToken();

    console.log('=== 3) Cobalt root ===');
    const root = await axios.get(COBALT_URL.replace(/\/$/, '') + '/', { timeout: 30000 });
    console.log('cobalt', root.data?.cobalt?.version, root.data?.cobalt?.url);

    console.log('=== 4) download ===');
    await testCobalt();
    console.log('ALL CHECKS PASSED');
}

main().catch((e) => {
    console.error('VERIFY FAILED:', e.message);
    process.exit(1);
});
