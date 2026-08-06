/**
 * Sync Connect YOUTUBE_COOKIES_B64 → cobalt-src/api/cookies.json
 * Usage: node scripts/sync-cobalt-cookies.js
 */
require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');

const out = path.resolve(__dirname, '../../cobalt-src/api/cookies.json');
const writer = path.resolve(__dirname, '../../cobalt/write-cobalt-cookies.js');

const env = {
    ...process.env,
    YOUTUBE_COOKIES_B64: process.env.YOUTUBE_COOKIES_B64 || '',
    YOUTUBE_COOKIES: process.env.YOUTUBE_COOKIES || '',
};

const r = spawnSync(process.execPath, [writer, out], {
    env,
    encoding: 'utf8',
});

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
