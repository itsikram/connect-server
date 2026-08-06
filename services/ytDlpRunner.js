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

/** Player clients to try in order when YouTube blocks datacenter IPs */
const PLAYER_CLIENTS = [
    'android',
    'tv_embedded',
    'ios',
    'mweb',
    'web',
];

let youtubedl = null;
try {
    youtubedl = require('youtube-dl-exec');
} catch (_) {
    youtubedl = null;
}

let cookiesFilePath = null;

const normalizeCookieText = (raw) => {
    let text = String(raw || '').trim();
    if (!text) return '';

    if (!text.includes('# Netscape HTTP Cookie File')) {
        text = `# Netscape HTTP Cookie File\n${text}`;
    }
    return text.endsWith('\n') ? text : `${text}\n`;
};

const initCookiesFromEnv = () => {
    if (cookiesFilePath && fs.existsSync(cookiesFilePath)) {
        return cookiesFilePath;
    }

    const cookiesB64 = process.env.YOUTUBE_COOKIES_B64;
    if (cookiesB64) {
        try {
            const decoded = Buffer.from(String(cookiesB64).trim(), 'base64').toString('utf8');
            cookiesFilePath = path.join(os.tmpdir(), 'connect-yt-cookies.txt');
            fs.writeFileSync(cookiesFilePath, normalizeCookieText(decoded), 'utf8');
            console.log('[yt-download] Loaded cookies from YOUTUBE_COOKIES_B64');
            return cookiesFilePath;
        } catch (err) {
            console.warn('Failed to decode YOUTUBE_COOKIES_B64:', err.message);
        }
    }

    const cookiesRaw = process.env.YOUTUBE_COOKIES;
    if (cookiesRaw) {
        try {
            const decoded = String(cookiesRaw).replace(/\\n/g, '\n');
            cookiesFilePath = path.join(os.tmpdir(), 'connect-yt-cookies.txt');
            fs.writeFileSync(cookiesFilePath, normalizeCookieText(decoded), 'utf8');
            console.log('[yt-download] Loaded cookies from YOUTUBE_COOKIES');
            return cookiesFilePath;
        } catch (err) {
            console.warn('Failed to write YOUTUBE_COOKIES:', err.message);
        }
    }

    const envFile = process.env.YOUTUBE_COOKIES_FILE;
    if (envFile && fs.existsSync(envFile)) {
        cookiesFilePath = envFile;
        console.log('[yt-download] Loaded cookies from YOUTUBE_COOKIES_FILE');
        return cookiesFilePath;
    }

    return null;
};

initCookiesFromEnv();

const isBotBlockError = (message) => {
    const lower = String(message || '').toLowerCase();
    return (
        lower.includes('sign in to confirm') ||
        lower.includes('not a bot') ||
        lower.includes('confirm you') ||
        lower.includes('cookies') && lower.includes('authentication')
    );
};

const formatBotBlockError = () =>
    'YouTube blocked this server (bot check). Add YOUTUBE_COOKIES_B64 to Render env vars — export cookies.txt from your browser while logged into YouTube, then base64-encode it.';

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

const buildSpawnArgs = (url, { outputPath, height, titleOnly, playerClient }) => {
    const args = [
        '--no-playlist',
        '--no-warnings',
        '--ffmpeg-location', FFMPEG_DIR,
        '--extractor-args', `youtube:player_client=${playerClient}`,
        '--retries', '3',
        '--fragment-retries', '3',
        '--socket-timeout', '30',
    ];

    const cookies = initCookiesFromEnv();
    if (cookies) {
        args.push('--cookies', cookies);
    }

    if (titleOnly) {
        args.push('--print', '%(title)s', '--skip-download', url);
        return args;
    }

    args.push(
        '-f', buildFormat(height),
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        '--newline',
        url
    );
    return args;
};

const isStandaloneAvailable = () => {
    const bin = getStandaloneBinaryPath();
    return Boolean(bin && fs.existsSync(bin));
};

const isYtDlpExecAvailable = () => Boolean(youtubedl);

const isYtDlpAvailable = async () => isStandaloneAvailable() || isYtDlpExecAvailable();

const getBundledYtDlpPath = () => getStandaloneBinaryPath();

const hasCookies = () => Boolean(initCookiesFromEnv());

const spawnYtDlp = (args) =>
    new Promise((resolve, reject) => {
        const bin = getStandaloneBinaryPath();
        if (!bin) {
            reject(new Error('Standalone yt-dlp binary not found'));
            return;
        }

        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            reject(new Error(stderr.trim() || stdout.trim() || `yt-dlp exited with code ${code}`));
        });
    });

const runWithClientRetries = async (runFn) => {
    let lastError = null;

    for (const client of PLAYER_CLIENTS) {
        try {
            console.log(`[yt-download] Trying player_client=${client}${hasCookies() ? ' (with cookies)' : ''}`);
            return await runFn(client);
        } catch (err) {
            lastError = err;
            console.warn(`[yt-download] player_client=${client} failed:`, err.message?.slice(0, 200));
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

const getVideoTitle = async (url) => {
    if (isStandaloneAvailable()) {
        return runWithClientRetries(async (client) => {
            const { stdout } = await spawnYtDlp(buildSpawnArgs(url, { titleOnly: true, playerClient: client }));
            const title = stdout.trim();
            if (title) return title;
            throw new Error('Could not read video title');
        });
    }

    if (youtubedl) {
        return runWithClientRetries(async (client) => {
            const flags = {
                noPlaylist: true,
                noWarnings: true,
                ffmpegLocation: FFMPEG_DIR,
                extractorArgs: `youtube:player_client=${client}`,
                print: '%(title)s',
                skipDownload: true,
            };
            const cookies = initCookiesFromEnv();
            if (cookies) flags.cookies = cookies;

            const result = await youtubedl(url, flags);
            const title = typeof result === 'string' ? result.trim() : String(result || '').trim();
            if (title) return title;
            throw new Error('Could not read video title');
        });
    }

    throw new Error('yt-dlp is not available on this server');
};

const downloadWithStandalone = ({ url, outputPath, height, onProgress, playerClient }) =>
    new Promise((resolve, reject) => {
        const bin = getStandaloneBinaryPath();
        if (!bin) {
            reject(new Error('Standalone yt-dlp binary not found'));
            return;
        }

        const args = buildSpawnArgs(url, { outputPath, height, titleOnly: false, playerClient });
        const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';

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
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve(outputPath);
                return;
            }
            reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        });
    });

const downloadWithExec = ({ url, outputPath, height, onProgress, playerClient }) =>
    new Promise((resolve, reject) => {
        if (!youtubedl) {
            reject(new Error('youtube-dl-exec not installed'));
            return;
        }

        const flags = {
            noPlaylist: true,
            noWarnings: true,
            ffmpegLocation: FFMPEG_DIR,
            mergeOutputFormat: 'mp4',
            retries: 3,
            fragmentRetries: 3,
            extractorArgs: `youtube:player_client=${playerClient}`,
            format: buildFormat(height),
            output: outputPath,
            newline: true,
        };
        const cookies = initCookiesFromEnv();
        if (cookies) flags.cookies = cookies;

        const subprocess = youtubedl.exec(url, flags);

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
                if (fs.existsSync(outputPath)) {
                    resolve(outputPath);
                    return;
                }
                reject(new Error('yt-dlp did not produce an output file'));
            })
            .catch(reject);
    });

const downloadWithYtDlp = async ({ url, outputPath, height, onProgress }) => {
    const attempt = async (playerClient) => {
        if (isStandaloneAvailable()) {
            return downloadWithStandalone({ url, outputPath, height, onProgress, playerClient });
        }
        if (youtubedl) {
            return downloadWithExec({ url, outputPath, height, onProgress, playerClient });
        }
        throw new Error('yt-dlp is not available. Run: node scripts/install-yt-dlp.js');
    };

    return runWithClientRetries(async (client) => {
        try {
            return await attempt(client);
        } catch (err) {
            if (fs.existsSync(outputPath)) {
                try { fs.unlinkSync(outputPath); } catch (_) {}
            }
            throw err;
        }
    });
};

module.exports = {
    isYtDlpAvailable,
    getVideoTitle,
    downloadWithYtDlp,
    getBundledYtDlpPath,
    getStandaloneBinaryPath,
    hasCookies,
    isBotBlockError,
    formatBotBlockError,
};
