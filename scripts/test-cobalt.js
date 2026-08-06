/**
 * Smoke-test Cobalt download path.
 * Usage: node scripts/test-cobalt.js [youtube-url]
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.COBALT_API_URL = process.env.COBALT_API_URL || 'https://api.cobalt.tools';
// Public instance usually has no API key — clear if pointing at public
if ((process.env.COBALT_API_URL || '').includes('api.cobalt.tools')) {
    delete process.env.COBALT_API_KEY;
}

const { downloadViaCobalt } = require('../services/ytCobaltFallback');

const url = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const outDir = path.join(os.tmpdir(), 'connect-yt-downloads');
const prefix = `cobalt-test-${Date.now()}`;

async function main() {
    console.log('Cobalt URL:', process.env.COBALT_API_URL);
    console.log('Video:', url);
    fs.mkdirSync(outDir, { recursive: true });

    const result = await downloadViaCobalt({
        url,
        height: 360,
        outputDir: outDir,
        outputPrefix: prefix,
        onProgress: (pct) => process.stdout.write(`\rProgress: ${pct}%   `),
    });

    console.log('\nSUCCESS');
    console.log('Title:', result.title);
    console.log('Source:', result.source);
    console.log('File:', result.filePath);
    console.log('Size:', fs.statSync(result.filePath).size, 'bytes');
}

main().catch((err) => {
    console.error('\nFAILED:', err.message);
    process.exit(1);
});
