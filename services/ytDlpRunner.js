const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

let youtubedl = null;
try {
    youtubedl = require('youtube-dl-exec');
} catch (_) {
    youtubedl = null;
}

const YT_DLP_BIN = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG_DIR = path.dirname(ffmpegInstaller.path);

const buildFormat = (height) =>
    height
        ? `best[height<=${height}][ext=mp4]/best[height<=${height}]/best[ext=mp4]/best`
        : 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';

const buildCommonFlags = () => {
    const flags = {
        noPlaylist: true,
        noWarnings: true,
        ffmpegLocation: FFMPEG_DIR,
        mergeOutputFormat: 'mp4',
    };

    const cookiesFile = process.env.YOUTUBE_COOKIES_FILE;
    if (cookiesFile && fs.existsSync(cookiesFile)) {
        flags.cookies = cookiesFile;
    }

    return flags;
};

const isSystemYtDlpAvailable = () =>
    new Promise((resolve) => {
        const proc = spawn(YT_DLP_BIN, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
    });

const isYtDlpAvailable = async () => Boolean(youtubedl) || isSystemYtDlpAvailable();

const getVideoTitleViaExec = async (url) => {
    if (!youtubedl) {
        throw new Error('youtube-dl-exec not installed');
    }

    const result = await youtubedl(url, {
        ...buildCommonFlags(),
        print: '%(title)s',
        skipDownload: true,
    });

    const title = typeof result === 'string' ? result.trim() : String(result || '').trim();
    if (!title) {
        throw new Error('Could not read video title');
    }
    return title;
};

const getVideoTitleViaSpawn = (url) =>
    new Promise((resolve, reject) => {
        const args = ['--print', '%(title)s', '--no-playlist', '--no-warnings', '--ffmpeg-location', FFMPEG_DIR, url];
        const proc = spawn(YT_DLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
                resolve(stdout.trim());
                return;
            }
            reject(new Error(stderr.trim() || `yt-dlp title fetch failed (${code})`));
        });
    });

const getVideoTitle = async (url) => {
    if (youtubedl) {
        try {
            return await getVideoTitleViaExec(url);
        } catch (err) {
            console.warn('youtube-dl-exec title fetch failed:', err.message);
        }
    }
    if (await isSystemYtDlpAvailable()) {
        return getVideoTitleViaSpawn(url);
    }
    throw new Error('No yt-dlp backend available');
};

const downloadWithExec = ({ url, outputPath, height, onProgress }) =>
    new Promise((resolve, reject) => {
        if (!youtubedl) {
            reject(new Error('youtube-dl-exec not installed'));
            return;
        }

        const subprocess = youtubedl.exec(url, {
            ...buildCommonFlags(),
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

const downloadWithSpawn = ({ url, outputPath, height, onProgress }) =>
    new Promise((resolve, reject) => {
        const args = [
            '-f', buildFormat(height),
            '--merge-output-format', 'mp4',
            '-o', outputPath,
            '--no-playlist',
            '--no-warnings',
            '--newline',
            '--ffmpeg-location', FFMPEG_DIR,
            url,
        ];

        const cookiesFile = process.env.YOUTUBE_COOKIES_FILE;
        if (cookiesFile && fs.existsSync(cookiesFile)) {
            args.push('--cookies', cookiesFile);
        }

        const proc = spawn(YT_DLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

const downloadWithYtDlp = ({ url, outputPath, height, onProgress }) => {
    if (youtubedl) {
        return downloadWithExec({ url, outputPath, height, onProgress }).catch((err) => {
            console.warn('youtube-dl-exec download failed:', err.message);
            if (fs.existsSync(outputPath)) {
                try { fs.unlinkSync(outputPath); } catch (_) {}
            }
            throw err;
        });
    }

    return isSystemYtDlpAvailable().then((available) => {
        if (!available) {
            throw new Error('No yt-dlp backend available');
        }
        return downloadWithSpawn({ url, outputPath, height, onProgress });
    });
};

module.exports = {
    isYtDlpAvailable,
    getVideoTitle,
    downloadWithYtDlp,
};
