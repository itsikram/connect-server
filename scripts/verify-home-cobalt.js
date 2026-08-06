/**
 * Verify home Cobalt is reachable from the internet (for live Connect on Render).
 * Usage: node scripts/verify-home-cobalt.js [public-cobalt-url]
 */
require('dotenv').config({ override: true });
const path = require('path');
const os = require('os');
const fs = require('fs');
const axios = require('axios');

const url = (process.argv[2] || process.env.COBALT_API_URL || '').replace(/\/$/, '');
const key = process.env.COBALT_API_KEY;
const video = process.argv[3] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

if (!url || url.includes('127.0.0.1') || url.includes('localhost')) {
    console.error('Pass your public tunnel URL, e.g.:');
    console.error('  node scripts/verify-home-cobalt.js https://cobalt.yourdomain.com');
    process.exit(1);
}

const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Connect-Server/1.0',
};
if (key) {
    headers.Authorization = key.startsWith('Api-Key ') ? key : `Api-Key ${key}`;
}

async function main() {
    console.log('Public Cobalt:', url);
    const root = await axios.get(`${url}/`, { headers, timeout: 60000, validateStatus: () => true });
    console.log('Root:', root.status, root.data?.cobalt?.version || root.data);

    const body = {
        url: video,
        downloadMode: 'auto',
        videoQuality: '360',
        youtubeVideoCodec: 'h264',
        alwaysProxy: true,
    };
    const res = await axios.post(`${url}/`, body, {
        headers,
        timeout: 180000,
        validateStatus: () => true,
    });
    if (res.status >= 400 || res.data?.status === 'error') {
        throw new Error(res.data?.error?.code || res.data?.text || `HTTP ${res.status}`);
    }
    const media = res.data?.url || res.data?.tunnel;
    if (!media) throw new Error('No media URL in response');

    console.log('Tunnel/media URL received, downloading sample...');
    const dl = await axios.get(media, {
        responseType: 'stream',
        timeout: 300000,
        headers: { Accept: '*/*', 'User-Agent': 'Connect-Server/1.0' },
        validateStatus: () => true,
    });
    if (dl.status >= 400) throw new Error(`Media download HTTP ${dl.status}`);

    const out = path.join(os.tmpdir(), `home-cobalt-verify-${Date.now()}.mp4`);
    await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(out);
        dl.data.pipe(w);
        w.on('finish', resolve);
        w.on('error', reject);
        dl.data.on('error', reject);
    });
    const size = fs.statSync(out).size;
    console.log('SUCCESS', size, 'bytes ->', out);
    if (size < 1000) throw new Error('File too small');
}

main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
