const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const FFMPEG_DIR = path.dirname(ffmpegInstaller.path);
const LOCAL_BIN_DIR = path.join(__dirname, '..', 'bin');
const LOCAL_YT_DLP = path.join(
    LOCAL_BIN_DIR,
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

let youtubedl = null;
try {
    youtubedl = require('youtube-dl-exec');
} catch (_) {
    youtubedl = null;
}

let cookiesFilePath = null;

const initCookiesFromEnv = () => {
    if (cookiesFilePath && fs.existsSync(cookiesFilePath)) {
        return cookiesFilePath;
    }

    const cookiesB64 = process.env.YOUTUBE_COOKIES_B64;
    if (cookiesB64) {
        try {
            const decoded = Buffer.from(String(cookiesB64).trim(), 'base64').toString('utf8');
            cookiesFilePath = path.join(require('os').tmpdir(), 'connect-yt-cookies.txt');
            fs.writeFileSync(cookiesFilePath, decoded, 'utf8');
            return cookiesFilePath;
        } catch (err) {
            console.warn('Failed to decode YOUTUBE_COOKIES_B64:', err.message);
        }
    }

    const envFile = process.env.YOUTUBE_COOKIES_FILE;
    if (envFile && fs.existsSync(envFile)) {
        cookiesFilePath = envFile;
        return cookiesFilePath;
    }

    return null;
};

initCookiesFromEnv();

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

const buildSpawnArgs = (url, { outputPath, height, titleOnly }) => {
    const args = [
        '--no-playlist',
        '--no-warnings',
        '--ffmpeg-location', FFMPEG_DIR,
        '--extractor-args', 'youtube:player_client=android,web',
        '--retries', '3',
        '--fragment-retries', '3',
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

const getVideoTitle = async (url) => {
    if (isStandaloneAvailable()) {
        const { stdout } = await spawnYtDlp(buildSpawnArgs(url, { titleOnly: true }));
        const title = stdout.trim();
        if (title) return title;
        throw new Error('Could not read video title');
    }

    if (youtubedl) {
        const result = await youtubedl(url, {
            noPlaylist: true,
            noWarnings: true,
            ffmpegLocation: FFMPEG_DIR,
            extractorArgs: 'youtube:player_client=android,web',
            print: '%(title)s',
            skipDownload: true,
        });
        const title = typeof result === 'string' ? result.trim() : String(result || '').trim();
        if (title) return title;
    }

    throw new Error('yt-dlp is not available on this server');
};

const downloadWithStandalone = ({ url, outputPath, height, onProgress }) =>
    new Promise((resolve, reject) => {
        const bin = getStandaloneBinaryPath();
        if (!bin) {
            reject(new Error('Standalone yt-dlp binary not found'));
            return;
        }

        const args = buildSpawnArgs(url, { outputPath, height, titleOnly: false });
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

const downloadWithExec = ({ url, outputPath, height, onProgress }) =>
    new Promise((resolve, reject) => {
        if (!youtubedl) {
            reject(new Error('youtube-dl-exec not installed'));
            return;
        }

        const subprocess = youtubedl.exec(url, {
            noPlaylist: true,
            noWarnings: true,
            ffmpegLocation: FFMPEG_DIR,
            mergeOutputFormat: 'mp4',
            retries: 3,
            fragmentRetries: 3,
            extractorArgs: 'youtube:player_client=android,web',
            format: buildFormat(height),
            output: outputPath,
            newline: true,
        });

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
    // Prefer standalone binary (no Python) — required on Render
    if (isStandaloneAvailable()) {
        return downloadWithStandalone({ url, outputPath, height, onProgress });
    }

    if (youtubedl) {
        try {
            return await downloadWithExec({ url, outputPath, height, onProgress });
        } catch (err) {
            if (fs.existsSync(outputPath)) {
                try { fs.unlinkSync(outputPath); } catch (_) {}
            }
            throw err;
        }
    }

    throw new Error(
        'yt-dlp is not available. Run: node scripts/install-yt-dlp.js'
    );
};

module.exports = {
    isYtDlpAvailable,
    getVideoTitle,
    downloadWithYtDlp,
    getBundledYtDlpPath,
    getStandaloneBinaryPath,
};
