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

// On cloud IPs, cookie-less clients almost always hit bot-check — try cookies first.
const DOWNLOAD_ATTEMPTS = [
    { client: 'android', useCookies: true, formatMode: 'any' },
    { client: 'ios', useCookies: true, formatMode: 'any' },
    { client: 'web', useCookies: true, formatMode: 'any' },
    { client: 'mweb', useCookies: true, formatMode: 'any' },
    { client: 'android,ios,web,mweb', useCookies: true, formatMode: 'any' },
    { client: 'android', useCookies: true, formatMode: 'preferred' },
    { client: 'web', useCookies: true, formatMode: 'preferred' },
    // Local / non-blocked IPs only — skipped on Render when cookies exist
    { client: 'android', useCookies: false, formatMode: 'any', localOnly: true },
];

const ESSENTIAL_COOKIE_NAMES = ['__Secure-1PSID', '__Secure-3PSID', 'VISITOR_INFO1_LIVE'];

const nodeMajor = parseInt(String(process.versions.node || '0').split('.')[0], 10) || 0;

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
        'YouTube blocked this cloud server IP (bot check / 403).',
        'Refresh YOUTUBE_COOKIES_B64 from a logged-in browser (Get cookies.txt LOCALLY).',
        'Optional: set YOUTUBE_PO_TOKEN and YOUTUBE_VISITOR_DATA.',
        'Recommended for Render: set COBALT_API_URL to a Cobalt instance for reliable downloads.',
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

/**
 * Prefer adaptive streams (android/ios often have no progressive MP4),
 * then progressive, then any best.
 */
const buildFormat = (height, mode = 'preferred') => {
    if (mode === 'any' || mode === 'loose') {
        return 'bv*+ba/b';
    }
    if (mode === 'progressive') {
        return height
            ? `b[height<=${height}][ext=mp4]/b[ext=mp4]/b`
            : 'b[ext=mp4]/b';
    }
    if (height) {
        return [
            `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba`,
            `b[height<=${height}][ext=mp4]/b[height<=${height}]`,
            'bv*+ba/b',
        ].join('/');
    }
    return 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b';
};

const buildExtractorArgs = (playerClient) => {
    if (process.env.YOUTUBE_EXTRACTOR_ARGS) {
        return process.env.YOUTUBE_EXTRACTOR_ARGS;
    }
    const parts = [`youtube:player_client=${playerClient}`];
    if (process.env.YOUTUBE_PO_TOKEN) {
        parts.push(`po_token=${process.env.YOUTUBE_PO_TOKEN}`);
    }
    if (process.env.YOUTUBE_VISITOR_DATA) {
        parts.push(`visitor_data=${process.env.YOUTUBE_VISITOR_DATA}`);
    }
    return parts.join(';');
};

const getJsRuntimeArgs = () => {
    const args = [];
    if (process.env.YT_DLP_JS_RUNTIME) {
        args.push('--js-runtimes', process.env.YT_DLP_JS_RUNTIME);
    } else if (fs.existsSync('/usr/local/bin/deno') || fs.existsSync('/usr/bin/deno')) {
        const deno = fs.existsSync('/usr/local/bin/deno') ? '/usr/local/bin/deno' : '/usr/bin/deno';
        args.push('--js-runtimes', `deno:${deno}`);
    } else if (nodeMajor >= 20) {
        args.push('--js-runtimes', `node:${process.execPath}`);
    }

    if (args.length) {
        args.push('--remote-components', process.env.YT_DLP_REMOTE_COMPONENTS || 'ejs:github');
    }
    return args;
};

const isFormatUnavailableError = (message) => {
    const lower = String(message || '').toLowerCase();
    return (
        lower.includes('requested format is not available') ||
        lower.includes('only images are available') ||
        lower.includes('no video formats') ||
        lower.includes('format not available') ||
        lower.includes('http error 403') ||
        lower.includes('unable to download api page')
    );
};

const isRetryableDownloadError = (message) => {
    if (isBotBlockError(message) || isFormatUnavailableError(message)) return true;
    const lower = String(message || '').toLowerCase();
    return (
        lower.includes('no output file') ||
        lower.includes('exited with code') ||
        lower.includes('http error') ||
        lower.includes('unable to download') ||
        lower.includes('fragment not found')
    );
};

const normalizeYouTubeUrl = (rawUrl) => {
    const input = String(rawUrl || '').trim().replace('m.youtube.com', 'www.youtube.com');
    try {
        const u = new URL(input);
        let videoId = u.searchParams.get('v');
        if (!videoId && u.hostname.includes('youtu.be')) {
            videoId = u.pathname.replace(/^\//, '').split('/')[0];
        }
        if (!videoId && u.pathname.startsWith('/shorts/')) {
            videoId = u.pathname.split('/')[2];
        }
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
    } catch (_) {}
    return input;
};

const resolveFfmpegLocation = () => {
    const candidates = [
        process.env.FFMPEG_PATH,
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        FFMPEG_DIR,
    ].filter(Boolean);

    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return c.endsWith('ffmpeg') || c.endsWith('ffmpeg.exe') ? path.dirname(c) : c;
        }
    }
    return FFMPEG_DIR;
};

const buildSpawnArgs = (url, { outputPath, height, playerClient, formatMode, useCookies }) => {
    const args = [
        '--no-playlist',
        '--no-simulate',
        '--ffmpeg-location', resolveFfmpegLocation(),
        '--extractor-args', buildExtractorArgs(playerClient),
        '--retries', '5',
        '--fragment-retries', '5',
        '--socket-timeout', '30',
        '--force-ipv4',
        ...getJsRuntimeArgs(),
    ];

    if (useCookies) {
        const cookies = initCookiesFromEnv();
        if (cookies) args.push('--cookies', cookies);
    }

    if (formatMode !== 'omit') {
        args.push('-f', buildFormat(height, formatMode));
    }
    args.push(
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        '--newline',
        '--print', 'before_dl:%(title)s',
        normalizeYouTubeUrl(url)
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
    if (!fs.existsSync(outputDir)) return null;
    const files = fs.readdirSync(outputDir)
        .filter((f) => f.startsWith(prefix) && !f.endsWith('.part') && !f.endsWith('.ytdl'))
        .filter((f) => /\.(mp4|mkv|webm|m4a|opus)$/i.test(f))
        .map((f) => ({
            name: f,
            mtime: fs.statSync(path.join(outputDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return path.join(outputDir, files[0].name);
};

const findFileFromStderr = (stderr) => {
    const text = String(stderr || '');
    const patterns = [
        /\[Merger\] Merging formats into "([^"]+)"/i,
        /\[download\] Destination: (.+)$/im,
        /\[Fixup[^\]]*\] Destination: (.+)$/im,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1] && fs.existsSync(m[1].trim())) return m[1].trim();
    }
    return null;
};

const listDirDebug = (outputDir, prefix) => {
    try {
        if (!fs.existsSync(outputDir)) return `(missing dir ${outputDir})`;
        const names = fs.readdirSync(outputDir).filter((f) => f.includes(prefix) || f.startsWith(prefix));
        return names.length ? names.join(', ') : '(none matching prefix)';
    } catch (err) {
        return `(readdir failed: ${err.message})`;
    }
};

const titleFromFilename = (filename, prefix) =>
    filename
        .replace(new RegExp(`^${prefix}[_-]?`), '')
        .replace(/\.(mp4|mkv|webm|m4a|opus)$/i, '')
        .replace(/_/g, ' ')
        .trim() || 'video';

const extractYtDlpError = (stderr, code, outputDir, outputPrefix) => {
    const errLines = String(stderr || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^ERROR:/i.test(l));
    if (errLines.length) return errLines[errLines.length - 1];

    const useful = String(stderr || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^\[download\]/i.test(l) && !/%/.test(l) && !/^WARNING:/i.test(l));
    if (useful.length) return useful[useful.length - 1].slice(0, 500);

    const listing = listDirDebug(outputDir, outputPrefix);
    return `yt-dlp exited with code ${code} (no output file found; dir=${listing})`;
};

const resolveOutput = ({ outputDir, outputPrefix, stderr, stdout }) => {
    const fromStderr = findFileFromStderr(stderr);
    const fromDir = findDownloadedFile(outputDir, outputPrefix);
    const printedTitle = String(stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();

    for (const candidate of [fromStderr, fromDir].filter(Boolean)) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
            const fromName = titleFromFilename(path.basename(candidate), outputPrefix);
            const title =
                (printedTitle && printedTitle.length > 2 && !printedTitle.includes(outputPrefix)
                    ? printedTitle
                    : null) || fromName;
            return { filePath: candidate, title };
        }
    }
    return null;
};

const downloadWithStandalone = ({ url, outputDir, outputPrefix, height, onProgress, playerClient, formatMode, useCookies }) =>
    new Promise((resolve, reject) => {
        const bin = getStandaloneBinaryPath();
        if (!bin) {
            reject(new Error('Standalone yt-dlp binary not found'));
            return;
        }

        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(path.resolve(outputDir), `${outputPrefix}.%(ext)s`);
        const args = buildSpawnArgs(url, {
            outputPath,
            height,
            playerClient,
            formatMode,
            useCookies,
        });
        console.log(
            `[yt-download] spawn client=${playerClient} cookies=${useCookies} format=${formatMode} -> ${outputPath}`
        );
        const proc = spawn(bin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` },
        });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            text.split('\n').forEach((line) => {
                if (/javascript runtime|ejs|no video formats|sign in|ERROR:|Destination:|Merging|Downloading/i.test(line)) {
                    console.warn('[yt-download]', line.trim().slice(0, 240));
                }
                const match = line.match(/(\d+(?:\.\d+)?)%/);
                if (match && typeof onProgress === 'function') {
                    onProgress(Math.min(95, Math.round(parseFloat(match[1]))));
                }
            });
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
            const resolved = resolveOutput({ outputDir, outputPrefix, stderr, stdout });
            if (resolved) {
                if (code !== 0) {
                    console.warn(`[yt-download] yt-dlp exit ${code} but file exists (${path.basename(resolved.filePath)})`);
                }
                resolve(resolved);
                return;
            }
            console.warn(`[yt-download] missing file after exit ${code}. stderrTail=${stderr.trim().slice(-400)}`);
            reject(new Error(extractYtDlpError(stderr, code, outputDir, outputPrefix)));
        });
    });

const downloadWithExec = ({ url, outputDir, outputPrefix, height, onProgress, playerClient, formatMode, useCookies }) =>
    new Promise((resolve, reject) => {
        if (!youtubedl) {
            reject(new Error('youtube-dl-exec not installed'));
            return;
        }

        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(path.resolve(outputDir), `${outputPrefix}.%(ext)s`);
        const flags = {
            noPlaylist: true,
            noSimulate: true,
            ffmpegLocation: resolveFfmpegLocation(),
            mergeOutputFormat: 'mp4',
            retries: 5,
            fragmentRetries: 5,
            forceIpv4: true,
            extractorArgs: buildExtractorArgs(playerClient),
            output: outputPath,
            newline: true,
            print: 'before_dl:%(title)s',
        };
        if (formatMode !== 'omit') {
            flags.format = buildFormat(height, formatMode);
        }
        if (useCookies) {
            const cookies = initCookiesFromEnv();
            if (cookies) flags.cookies = cookies;
        }

        const jsArgs = getJsRuntimeArgs();
        for (let i = 0; i < jsArgs.length; i += 2) {
            if (jsArgs[i] === '--js-runtimes') flags.jsRuntimes = jsArgs[i + 1];
            if (jsArgs[i] === '--remote-components') flags.remoteComponents = jsArgs[i + 1];
        }

        const subprocess = youtubedl.exec(normalizeYouTubeUrl(url), flags);
        let stdout = '';
        let stderr = '';

        if (subprocess.stdout) {
            subprocess.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        }
        if (subprocess.stderr) {
            subprocess.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                stderr += text;
                text.split('\n').forEach((line) => {
                    if (/javascript runtime|ejs|no video formats|sign in|ERROR:|Destination:|Merging/i.test(line)) {
                        console.warn('[yt-download]', line.trim().slice(0, 240));
                    }
                    const match = line.match(/(\d+(?:\.\d+)?)%/);
                    if (match && typeof onProgress === 'function') {
                        onProgress(Math.min(95, Math.round(parseFloat(match[1]))));
                    }
                });
            });
        }

        const finish = () => resolveOutput({ outputDir, outputPrefix, stderr, stdout });

        subprocess
            .then(() => {
                const ok = finish();
                if (ok) {
                    resolve(ok);
                    return;
                }
                reject(new Error(extractYtDlpError(stderr, 0, outputDir, outputPrefix)));
            })
            .catch((err) => {
                const ok = finish();
                if (ok) {
                    resolve(ok);
                    return;
                }
                reject(new Error(err?.message || extractYtDlpError(stderr, 1, outputDir, outputPrefix)));
            });
    });

const cleanupPartial = (outputDir, outputPrefix) => {
    try {
        if (!fs.existsSync(outputDir)) return;
        for (const f of fs.readdirSync(outputDir)) {
            if (f.startsWith(outputPrefix)) {
                try { fs.unlinkSync(path.join(outputDir, f)); } catch (_) {}
            }
        }
    } catch (_) {}
};

const downloadWithYtDlp = async ({ url, outputDir, outputPrefix, height, onProgress }) => {
    let lastError = null;
    const cleanUrl = normalizeYouTubeUrl(url);

    console.log(`[yt-download] JS runtime args: ${getJsRuntimeArgs().join(' ') || 'none'}`);

    for (const attempt of DOWNLOAD_ATTEMPTS) {
        if (attempt.formatMode === 'preferred' && !height) continue;
        if (attempt.useCookies && !hasCookies()) continue;
        // Skip cookie-less attempts on cloud when we already have cookies (they only waste time)
        if (attempt.localOnly && (process.env.RENDER === 'true' || hasCookies())) continue;

        try {
            console.log(
                `[yt-download] Trying player_client=${attempt.client}` +
                `${attempt.useCookies ? ' (with cookies)' : ' (no cookies)'}` +
                ` [format=${attempt.formatMode}${height && attempt.formatMode === 'preferred' ? ` height<=${height}` : ''}]`
            );
            const opts = {
                url: cleanUrl,
                outputDir,
                outputPrefix,
                height,
                onProgress,
                playerClient: attempt.client,
                formatMode: attempt.formatMode,
                useCookies: attempt.useCookies,
            };
            const result = await (isStandaloneAvailable()
                ? downloadWithStandalone(opts)
                : downloadWithExec(opts));
            return result;
        } catch (err) {
            lastError = err;
            console.warn(`[yt-download] player_client=${attempt.client} failed:`, err.message?.slice(0, 220));
            cleanupPartial(outputDir, outputPrefix);
            if (!isRetryableDownloadError(err.message)) {
                throw err;
            }
        }
    }

    if (isBotBlockError(lastError?.message)) {
        throw new Error(formatBotBlockError());
    }
    if (isFormatUnavailableError(lastError?.message)) {
        throw new Error(
            'YouTube returned no downloadable formats. Ensure the server runs Node 22+ (or Deno), ' +
            'yt-dlp is up to date, and YOUTUBE_COOKIES_B64 is valid. Redeploy with the updated Dockerfile.'
        );
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
    isFormatUnavailableError,
    formatBotBlockError,
    validateNetscapeCookies,
    normalizeYouTubeUrl,
};

