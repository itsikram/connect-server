const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DriveConnection, DriveConsent, DriveFile } = require('../models/PersonalDrive');
const Message = require('../models/Message');
const Profile = require('../models/Profile');
const drive = require('../services/personalDrive');
const { uploadImage, uploadFile } = require('./uploadControllers');

const ownerId = (req) => String(req.profile._id);
const stillValid = () => ({ $gt: new Date() });
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);
const safeName = (value) => String(value || 'attachment').split(/[\\/]/).pop()
    .replace(/[\x00-\x1f\x7f]/g, '').trim() || 'attachment';

exports.status = async (req, res) => {
    const connection = await DriveConnection.findById(ownerId(req)).lean();
    res.json({
        available: Boolean(drive.settings()),
        connected: Boolean(connection),
        enabled: connection?.enabled ?? false,
        email: connection?.email ?? null,
    });
};

exports.start = async (req, res) => {
    const config = drive.settings();
    if (!config) return res.status(503).json({ error: 'Google Drive storage is unavailable.' });
    const state = drive.randomId();
    const verifier = drive.randomId() + drive.randomId();
    await DriveConsent.create({
        _id: drive.hash(state),
        owner: ownerId(req),
        verifier,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    res.json({ authorizationUrl: drive.consentUrl(config, state, verifier) });
};

exports.callback = async (req, res) => {
    const config = drive.settings();
    const { state, code } = req.query;
    try {
        if (!config || typeof state !== 'string') throw new Error('Invalid consent');
        const consent = await DriveConsent.findOneAndDelete({ _id: drive.hash(state), expiresAt: stillValid() });
        if (!consent || typeof code !== 'string') throw new Error('Invalid consent');
        const account = await drive.authorize(config, code, consent.verifier);
        await DriveConnection.findByIdAndUpdate(consent.owner, {
            googleSubject: account.subject,
            email: account.email,
            enabled: true,
            refreshToken: drive.sealToken(config, consent.owner, account.subject, account.token),
        }, { upsert: true });
        res.type('text').send('Google Drive connected. Return to Connect to use your storage.');
    } catch {
        res.status(400).type('text').send('Google Drive could not be connected. Return to Connect and try again.');
    }
};

exports.update = async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ error: 'Choose whether to use Google Drive for new uploads.' });
    }
    const connection = await DriveConnection.findByIdAndUpdate(ownerId(req), {
        enabled: req.body.enabled,
    }, { new: true });
    if (!connection) return res.status(409).json({ error: 'Connect your Google Drive first.' });
    res.json({ enabled: connection.enabled });
};

exports.disconnect = async (req, res) => {
    const owner = ownerId(req);
    await DriveConsent.deleteMany({ owner });
    await DriveConnection.deleteOne({ _id: owner });
    res.sendStatus(204);
};

exports.prepareUpload = async (req, res, next) => {
    if (!['image', 'file', 'voice'].includes(req.params.kind)) return res.sendStatus(404);
    const connection = await DriveConnection.findById(ownerId(req)).select('+refreshToken').lean();
    if (connection?.enabled) {
        const config = drive.settings();
        if (!config) return res.status(503).json({ error: 'Google Drive storage is unavailable.' });
        req.personalDriveUpload = { connection, config };
    }
    next();
};

exports.upload = async (req, res, next) => {
    const { kind } = req.params;
    if (!req.personalDriveUpload) {
        return (kind === 'image' ? uploadImage : uploadFile)(req, res, next);
    }
    const { connection, config } = req.personalDriveUpload;
    const owner = ownerId(req);
    const recipient = req.body?.recipient;
    if (typeof recipient !== 'string' || !/^[a-f0-9]{24}$/i.test(recipient) ||
        !(await Profile.exists({ _id: recipient }))) {
        return res.status(400).json({ error: 'Select a chat recipient before uploading.' });
    }
    if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'Select a file to upload.' });
    }

    let mime = imageTypes.has(req.file.mimetype) ? req.file.mimetype : 'application/octet-stream';
    if (kind === 'image' && !imageTypes.has(mime)) {
        return res.status(415).json({ error: 'This image format is unsupported.' });
    }
    let bytes = req.file.buffer;
    const originalName = safeName(req.file.originalname);
    let name = Array.from(originalName).slice(0, 55).join('');
    const extension = /\.[a-z0-9]{1,10}$/i.exec(originalName)?.[0];
    if (extension && !name.endsWith(extension)) name += extension;
    if (kind === 'voice') {
        try {
            bytes = await drive.normalizeVoice(bytes);
        } catch {
            return res.status(422).json({ error: 'Connect could not read this voice recording.' });
        }
        name = name.replace(/\.[^.]+$/, '') + '.mp3';
        mime = 'audio/mpeg';
    }

    let token;
    let driveId;
    try {
        token = await drive.getAccessToken(config, connection);
        driveId = await drive.createFile(token, name, mime, bytes);
        if (!driveId) throw new Error('Google Drive did not return a file ID');
        const id = drive.randomId();
        const attachmentKind = imageTypes.has(mime) ? 'image' : kind;
        await DriveFile.create({
            _id: id, owner, recipient: recipient.toLowerCase(),
            googleSubject: connection.googleSubject, driveId, name, mime, kind: attachmentKind,
        });
        return res.json({ secure_url: `drive-chat:${id}:${attachmentKind}` });
    } catch {
        if (driveId) await drive.removeFile(token, driveId).catch(() => {});
        return res.status(502).json({ error: 'Could not save to your Google Drive. Check your Drive connection and available storage.' });
    }
};

exports.download = async (req, res, next) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.sendStatus(404);
    const file = await DriveFile.findById(req.params.id).lean();
    if (!file) return res.sendStatus(404);
    const viewer = ownerId(req);
    if (viewer !== file.owner) {
        if (viewer !== file.recipient || !(await Message.exists({
            senderId: file.owner,
            receiverId: viewer,
            attachment: `drive-chat:${file._id}:${file.kind}`,
        }))) return res.sendStatus(404);
    }

    const config = drive.settings();
    const connection = await DriveConnection.findOne({
        _id: file.owner, googleSubject: file.googleSubject,
    }).select('+refreshToken').lean();
    if (!config || !connection) {
        return res.status(503).json({ error: 'The uploader’s Google Drive is disconnected.' });
    }

    try {
        const token = await drive.getAccessToken(config, connection);
        const content = await drive.readFile(token, file.driveId);
        res.attachment(file.name);
        res.set({ 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff' });
        const length = content.headers.get('content-length');
        if (length && !content.headers.has('content-encoding')) res.set('Content-Length', length);
        await pipeline(Readable.fromWeb(content.body), res);
    } catch (error) {
        if (res.headersSent || res.destroyed) return;
        if (error.googleStatus === 404) return res.sendStatus(404);
        return res.status(502).json({ error: 'Could not read this file from Google Drive.' });
    }
};
