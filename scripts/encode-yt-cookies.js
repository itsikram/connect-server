/**
 * Encode cookies.txt to base64 for YOUTUBE_COOKIES_B64 on Render.
 * Usage: node scripts/encode-yt-cookies.js path/to/cookies.txt
 */
const fs = require('fs');
const path = require('path');
const { validateNetscapeCookies } = require('../services/ytDlpRunner');

const file = process.argv[2];
if (!file) {
    console.error('Usage: node scripts/encode-yt-cookies.js path/to/cookies.txt');
    process.exit(1);
}

const abs = path.resolve(file);
if (!fs.existsSync(abs)) {
    console.error('File not found:', abs);
    process.exit(1);
}

const text = fs.readFileSync(abs, 'utf8');
const validation = validateNetscapeCookies(text);

console.log('\n=== Cookie validation ===');
console.log('YouTube rows:', validation.youtubeRows);
console.log('Unique cookie names:', validation.total);
console.log('Missing essential:', validation.missing.length ? validation.missing.join(', ') : 'none');
console.log('Valid:', validation.ok ? 'YES' : 'NO — re-export from youtube.com while logged in');

if (!validation.ok) {
    console.error('\nFix cookies before deploying. Export from youtube.com using "Get cookies.txt LOCALLY".');
    process.exit(1);
}

const b64 = Buffer.from(text, 'utf8').toString('base64');
console.log('\n=== Add this to Render Environment ===');
console.log('Key:   YOUTUBE_COOKIES_B64');
console.log('Value: (copy below)\n');
console.log(b64);
console.log('\n');
