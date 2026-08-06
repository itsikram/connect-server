/**
 * Local smoke test for YouTube download API.
 * Usage: node scripts/test-yt-download.js [youtube-url]
 */
require('dotenv').config();
const axios = require('axios');

const BASE = process.env.YT_TEST_BASE || 'http://localhost:4000';
const TEST_URL = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    console.log('Testing YouTube download at', BASE);
    console.log('URL:', TEST_URL);

    const encoded = encodeURIComponent(TEST_URL);
    const startUrl = `${BASE}/download?url=${encoded}&ext=mp4&height=360&link_only=true&async_job=true`;

    const startRes = await axios.get(startUrl, {
        headers: { Accept: 'application/json' },
        timeout: 120000,
    });

    console.log('Start response:', startRes.status, startRes.data);

    const progressUrl = startRes.data?.progress_url;
    if (!progressUrl) {
        throw new Error('No progress_url returned');
    }

    for (let i = 0; i < 180; i++) {
        await sleep(2000);
        const progRes = await axios.get(progressUrl, {
            headers: { Accept: 'application/json' },
            params: { _ts: Date.now() },
            timeout: 60000,
        });
        const data = progRes.data || {};
        console.log(`[${i + 1}] ${data.status} | ${data.stage} | ${data.pct}% | source=${data.source || '-'}`);

        if (data.status === 'completed' && data.file_url) {
            console.log('\nSUCCESS');
            console.log('Title:', data.title || data.download_title);
            console.log('File URL:', data.file_url);
            process.exit(0);
        }

        if (data.status === 'failed') {
            throw new Error(data.error || 'Download failed');
        }
    }

    throw new Error('Timed out waiting for download');
}

main().catch((err) => {
    console.error('\nFAILED:', err.response?.data || err.message);
    process.exit(1);
});
