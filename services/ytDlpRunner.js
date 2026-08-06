const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const FFMPEG_DIR = path.dirname(ffmpegInstaller.path);
const LOCAL_BIN_DIR = path.join(__dirname, '..', 'bin');
const LOCAL_YT_DLP = path.join(
    LOCAL_BIN_DIR,
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

const PLAYER_CLIENTS = ['android', 'tv_embedded', 'ios', 'mweb', 'web_creator', 'web'];

const ESSENTIAL_COOKIE_NAMES = ['__Secure-1PSID', '__Secure-3PSID', 'VISITOR_INFO1_LIVE'];

let youtubedl = null;
try {
    youtubedl = require('youtube-dl-exec');
} catch (_) {
    youtubedl = null;
}

let cookiesFilePath = null;
let cookieValidation = null;

const normalizeCookieText = (raw) => {
    let text = String(raw || '').trim();
    if (!text) return '';

    if (text.startsWith('[')) {
        try {
            text = jsonCookiesToNetscape(JSON.parse(text));
        } catch (_) {}
    }

    if (!text.includes('# Netscape HTTP Cookie File')) {
        text = `# Netscape HTTP Cookie File\n${text}`;
    }
    return text.endsWith('\n') ? text : `${text}\n`;
};

const jsonCookiesToNetscape = (cookies) => {
    if (!Array.isArray(cookies)) {
        throw new Error('YOUTUBE_COOKIES_JSON must be a JSON array');
    }

    const lines = [
        '# Netscape HTTP Cookie File',
        '# https://curl.haxx.se/rfc/cookie_spec.html',
        '',
    ];

    for (const c of cookies) {
        if (!c?.name || c.value === undefined) continue;
        const domain = c.domain || '.youtube.com';
        const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const cookiePath = c.path || '/';
        const secure = c.secure ? 'TRUE' : 'FALSE';
        const expiry = Math.floor(c.expirationDate || c.expires || (Date.now() / 1000 + 86400 * 30));
        lines.push([domain, flag, cookiePath, secure, expiry, c.name, String(c.value)].join('\t'));
    }

    return `${lines.join('\n')}\n`;
};

const validateNetscapeCookies = (text) => {
    const names = new Set();
    let youtubeRows = 0;

    for (const line of String(text).split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('\t');
        if (parts.length < 7) continue;
        names.add(parts[5]);
        if (parts[0].includes('youtube.com')) youtubeRows += 1;
    }

    const missing = ESSENTIAL_COOKIE_NAMES.filter((n) => !names.has(n));
    return {
        total: names.size,
        youtubeRows,
        missing,
        ok: youtubeRows > 0 && missing.length === 0,
    };
};

const decodeCookiesPayload = (raw) => {
    const trimmed = String(raw || '').trim().replace(/^['"]|['"]$/g, '');

    if (trimmed.startsWith('[')) {
        return jsonCookiesToNetscape(JSON.parse(trimmed));
    }

    if (trimmed.includes('youtube.com') || trimmed.startsWith('# Netscape')) {
        return normalizeCookieText(trimmed);
    }

    try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
        if (decoded.includes('youtube.com') || decoded.startsWith('# Netscape') || decoded.startsWith('[')) {
            return normalizeCookieText(decoded);
        }
    } catch (_) {}

    return normalizeCookieText(trimmed);
};

const initCookiesFromEnv = () => {
    if (cookiesFilePath && fs.existsSync(cookiesFilePath)) {
        return cookiesFilePath;
    }

    const sources = [
        ['YOUTUBE_COOKIES_JSON', process.env.YOUTUBE_COOKIES_JSON],
        ['YOUTUBE_COOKIES_B64', process.env.YOUTUBE_COOKIES_B64],
        ['YOUTUBE_COOKIES', process.env.YOUTUBE_COOKIES?.replace(/\\n/g, '\n')],
    ];

    for (const [label, value] of sources) {
        if (!value) continue;
        try {
            const netscape = decodeCookiesPayload(value);
            cookieValidation = validateNetscapeCookies(netscape);
            cookiesFilePath = path.join(os.tmpdir(), 'connect-yt-cookies.txt');
            fs.writeFileSync(cookiesFilePath, netscape, 'utf8');
            console.log(
                `[yt-download] Cookies loaded from ${label}: ${cookieValidation.youtubeRows} youtube.com rows, ${cookieValidation.total} unique names` +
                (cookieValidation.missing.length
                    ? `, MISSING: ${cookieValidation.missing.join(', ')}`
                    : ', essential cookies present')
            );
            return cookiesFilePath;
        } catch (err) {
            console.warn(`[yt-download] Failed to load ${label}:`, err.message);
        }
    }

    const envFile = process.env.YOUTUBE_COOKIES_FILE;
    if (envFile && fs.existsSync(envFile)) {
        const netscape = fs.readFileSync(envFile, 'utf8');
        cookieValidation = validateNetscapeCookies(netscape);
        cookiesFilePath = envFile;
        console.log('[yt-download] Cookies loaded from YOUTUBE_COOKIES_FILE');
        return cookiesFilePath;
    }

    cookieValidation = null;
    return null;
};

initCookiesFromEnv();

const isBotBlockError = (message) => {
    const lower = String(message || '').toLowerCase();
    return (
        lower.includes('sign in to confirm') ||
        lower.includes('not a bot') ||
        lower.includes('confirm you') ||
        (lower.includes('cookies') && lower.includes('authentication'))
    );
};

const formatBotBlockError = () => {
    const parts = [
        'YouTube bot check failed on the cloud server.',
        'Re-export fresh cookies.txt from youtube.com while logged in (use Get cookies.txt LOCALLY extension).',
        'Required cookie names: __Secure-1PSID, __Secure-3PSID, VISITOR_INFO1_LIVE.',
        'Set YOUTUBE_COOKIES_B64 on Render with base64 of that file.',
        'Run locally: node scripts/encode-yt-cookies.js path/to/cookies.txt',
    ];

    if (cookieValidation) {
        parts.push(
            `Current cookies: ${cookieValidation.youtubeRows} youtube rows, missing: ${cookieValidation.missing.join(', ') || 'none'}.`
        );
    } else {
        parts.push('No valid cookies detected on the server.');
    }

    return parts.join(' ');
};

const getStandaloneBinaryPath = () => {
    if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
        return process.env.YT_DLP_PATH;
    }
    if (fs.existsSync(LOCAL_YT_DLP)) {
        return LOCAL_YT_DLP;
    }
    return null;
};

const buildFormat = (height) =>
    height
        ? `best[height<=${height}][ext=mp4]/best[height<=${height}]/best[ext=mp4]/best`
        : 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';

const buildExtractorArgs = (playerClient) => {
    const parts = [`youtube:player_client=${playerClient}`];
    if (process.env.YOUTUBE_PO_TOKEN) {
        parts.push(`po_token=${process.env.YOUTUBE_PO_TOKEN}`);
    }
    if (process.env.YOUTUBE_EXTRACTOR_ARGS) {
        return process.env.YOUTUBE_EXTRACTOR_ARGS;
    }
    return parts.join(';');
};

const buildSpawnArgs = (url, { outputTemplate, height, playerClient }) => {
    const args = [
        '--no-playlist',
        '--no-warnings',
        '--ffmpeg-location', FFMPEG_DIR,
        '--extractor-args', buildExtractorArgs(playerClient),
        '--retries', '3',
        '--fragment-retries', '3',
        '--socket-timeout', '30',
    ];

    const cookies = initCookiesFromEnv();
    if (cookies) {
        args.push('--cookies', cookies);
    }

    args.push(
        '-f', buildFormat(height),
        '--merge-output-format', 'mp4',
        '-o', outputTemplate,
        '--newline',
        '--print', '%(title)s',
        url
    );
    return args;
};

const isStandaloneAvailable = () => {
    const bin = getStandaloneBinaryPath();
    return Boolean(bin && fs.existsSync(bin));
};

const isYtDlpAvailable = async () => isStandaloneAvailable() || Boolean(youtubedl);

const getBundledYtDlpPath = () => getStandaloneBinaryPath();

const hasCookies = () => Boolean(initCookiesFromEnv());

const findDownloadedFile = (outputDir, prefix) => {
    const files = fs.readdirSync(outputDir).filter((f) => f.startsWith(prefix) && /\.(mp4|mkv|webm)$/i.test(f));
    if (!files.length) return null;
    return path.join(outputDir, files[0]);
};

const titleFromFilename = (filename, prefix) =>
    filename
        .replace(new RegExp(`^${prefix}_`), '')
        .replace(/\.(mp4|mkv|webm)$/i, '')
        .replace(/_/g, ' ')
        .trim() || 'video';

const downloadWithStandalone = ({ url, outputDir, outputPrefix, height, onProgress, playerClient }) =>
    new Promise((resolve, reject) => {
        const bin = getStandaloneBinaryPath();
        if (!bin) {
            reject(new Error('Standalone yt-dlp binary not found'));
            return;
        }

        const outputTemplate = path.join(outputDir, `${outputPrefix}_%(title).100B.%(ext)s`);
        const args = buildSpawnArgs(url, { outputTemplate, height, playerClient });
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            text.split('\n').forEach((line) => {
                const match = line.match(/(\d+(?:\.\d+)?)%/);
                if (match && typeof onProgress === 'function') {
                    onProgress(Math.min(95, Math.round(parseFloat(match[1]))));
                }
            });
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
            const filePath = findDownloadedFile(outputDir, outputPrefix);
            if (code === 0 && filePath) {
                const titleFromStdout = stdout.trim().split('\n').filter(Boolean).pop();
                const title = titleFromStdout || titleFromFilename(path.basename(filePath), outputPrefix);
                resolve({ filePath, title });
                return;
            }
            reject(new Error(stderr.trim() || stdout.trim() || `yt-dlp exited with code ${code}`));
        });
    });

const downloadWithExec = ({ url, outputDir, outputPrefix, height, onProgress, playerClient }) =>
    new Promise((resolve, reject) => {
        if (!youtubedl) {
            reject(new Error('youtube-dl-exec not installed'));
            return;
        }

        const outputTemplate = path.join(outputDir, `${outputPrefix}_%(title).100B.%(ext)s`);
        const flags = {
            noPlaylist: true,
            noWarnings: true,
            ffmpegLocation: FFMPEG_DIR,
            mergeOutputFormat: 'mp4',
            retries: 3,
            fragmentRetries: 3,
            extractorArgs: buildExtractorArgs(playerClient),
            format: buildFormat(height),
            output: outputTemplate,
            newline: true,
            print: '%(title)s',
        };
        const cookies = initCookiesFromEnv();
        if (cookies) flags.cookies = cookies;

        const subprocess = youtubedl.exec(url, flags);
        let stdout = '';

        if (subprocess.stdout) {
            subprocess.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        }
        if (subprocess.stderr) {
            subprocess.stderr.on('data', (chunk) => {
                chunk.toString().split('\n').forEach((line) => {
                    const match = line.match(/(\d+(?:\.\d+)?)%/);
                    if (match && typeof onProgress === 'function') {
                        onProgress(Math.min(95, Math.round(parseFloat(match[1]))));
                    }
                });
            });
        }

        subprocess
            .then(() => {
                const filePath = findDownloadedFile(outputDir, outputPrefix);
                if (filePath) {
                    const titleFromStdout = stdout.trim().split('\n').filter(Boolean).pop();
                    resolve({
                        filePath,
                        title: titleFromStdout || titleFromFilename(path.basename(filePath), outputPrefix),
                    });
                    return;
                }
                reject(new Error('yt-dlp did not produce an output file'));
            })
            .catch(reject);
    });

const downloadWithYtDlp = async ({ url, outputDir, outputPrefix, height, onProgress }) => {
    let lastError = null;

    for (const client of PLAYER_CLIENTS) {
        try {
            console.log(`[yt-download] Trying player_client=${client}${hasCookies() ? ' (with cookies)' : ''}`);
            const attempt = isStandaloneAvailable()
                ? downloadWithStandalone({ url, outputDir, outputPrefix, height, onProgress, playerClient: client })
                : downloadWithExec({ url, outputDir, outputPrefix, height, onProgress, playerClient: client });

            return await attempt;
        } catch (err) {
            lastError = err;
            console.warn(`[yt-download] player_client=${client} failed:`, err.message?.slice(0, 220));
            const partial = findDownloadedFile(outputDir, outputPrefix);
            if (partial) {
                try { fs.unlinkSync(partial); } catch (_) {}
            }
            if (!isBotBlockError(err.message)) {
                throw err;
            }
        }
    }

    if (isBotBlockError(lastError?.message)) {
        throw new Error(formatBotBlockError());
    }
    throw lastError || new Error('yt-dlp failed for all player clients');
};

module.exports = {
    isYtDlpAvailable,
    downloadWithYtDlp,
    getBundledYtDlpPath,
    getStandaloneBinaryPath,
    hasCookies,
    isBotBlockError,
    formatBotBlockError,
    validateNetscapeCookies,
};
