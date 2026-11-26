const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CHAT_LIMIT = 25 * 1024 * 1024;
const FILE_REF = /^drive-chat:([a-f0-9]{32}):(image|file|voice)$/;
const randomId = () => crypto.randomBytes(16).toString('hex');
const hash = (value) => crypto.createHash('sha256').update(value).digest('base64url');

function settings() {
    const clientId = process.env.PERSONAL_DRIVE_CLIENT_ID;
    const clientSecret = process.env.PERSONAL_DRIVE_CLIENT_SECRET;
    const redirectUri = process.env.PERSONAL_DRIVE_REDIRECT_URI;
    const rawKey = process.env.PERSONAL_DRIVE_TOKEN_KEY || '';
    const key = Buffer.from(rawKey, 'base64');
    return clientId && clientSecret && redirectUri && key.length === 32
        ? { clientId, clientSecret, redirectUri, key }
        : null;
}

function tokenCipher(config, owner, subject, iv, tag) {
    const cipher = tag
        ? crypto.createDecipheriv('aes-256-gcm', config.key, iv)
        : crypto.createCipheriv('aes-256-gcm', config.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([owner, subject])));
    if (tag) cipher.setAuthTag(tag);
    return cipher;
}

function sealToken(config, owner, subject, token) {
    const iv = crypto.randomBytes(12);
    const cipher = tokenCipher(config, owner, subject, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
}

async function google(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        redirect: 'error',
        signal: options.signal || AbortSignal.timeout(60000),
    });
    if (!response.ok) {
        await response.body?.cancel();
        const error = new Error('Google Drive request failed');
        error.googleStatus = response.status;
        throw error;
    }
    return response;
}

function consentUrl(config, state, verifier) {
    const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: `openid email ${SCOPE}`,
        access_type: 'offline',
        prompt: 'consent select_account',
        state,
        code_challenge: hash(verifier),
        code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

async function exchange(config, params) {
    return (await google('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            ...params,
        }),
    })).json();
}

async function authorize(config, code, verifier) {
    const token = await exchange(config, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: config.redirectUri,
    });
    if (!token.refresh_token || !token.scope?.split(' ').includes(SCOPE)) {
        throw new Error('Drive permission was not granted');
    }
    const account = await (await google('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
    })).json();
    if (!account.sub || !account.email || account.email_verified !== true) {
        throw new Error('Google account could not be verified');
    }
    return { subject: account.sub, email: account.email, token: token.refresh_token };
}

async function getAccessToken(config, connection) {
    const [iv, tag, encrypted] = connection.refreshToken.split('.').map((part) => Buffer.from(part, 'base64'));
    const cipher = tokenCipher(config, connection.id, connection.googleSubject, iv, tag);
    const refreshToken = Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
    const token = await exchange(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
    return token.access_token;
}

async function createFile(accessToken, name, mime, bytes) {
    const session = await google('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': mime,
            'X-Upload-Content-Length': String(bytes.length),
        },
        body: JSON.stringify({ name, mimeType: mime }),
    });
    const location = session.headers.get('location');
    await session.body?.cancel();
    const url = new URL(location);
    if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/upload/drive/v3/files') {
        throw new Error('Google Drive returned an invalid upload session');
    }
    const result = await google(url, {
        method: 'PUT',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': mime,
            'Content-Length': String(bytes.length),
        },
        body: bytes,
    });
    return (await result.json()).id;
}

const fileUrl = (id) => `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
const readFile = (token, id) => google(`${fileUrl(id)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
});
const removeFile = (token, id) => google(fileUrl(id), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
});

function normalizeVoice(bytes) {
    return new Promise((resolve, reject) => {
        const { path } = require('@ffmpeg-installer/ffmpeg');
        const child = spawn(path, [
            '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe',
            '-i', 'pipe:0', '-map', '0:a:0',
            '-ac', '1', '-b:a', '96k', '-f', 'mp3', 'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 30000 });
        const chunks = [];
        let length = 0;
        child.stdout.on('data', (chunk) => {
            length += chunk.length;
            if (length > CHAT_LIMIT) {
                child.kill();
                return;
            }
            chunks.push(chunk);
        });
        child.stdin.on('error', reject);
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0 || !length || length > CHAT_LIMIT) {
                return reject(new Error('Voice conversion failed'));
            }
            resolve(Buffer.concat(chunks, length));
        });
        child.stdin.end(bytes);
    });
}

module.exports = {
    CHAT_LIMIT, FILE_REF, randomId, hash, settings, sealToken, consentUrl, authorize,
    getAccessToken, createFile, readFile, removeFile, normalizeVoice,
};
