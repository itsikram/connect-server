const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const crypto = require('node:crypto');
const { once } = require('node:events');
const controller = require('./personalDriveController');
const { DriveConnection, DriveFile } = require('../models/PersonalDrive');
const Message = require('../models/Message');
const drive = require('../services/personalDrive');
const validateAttachment = require('../utils/personalDriveMessage');

test('Drive consent requests only per-file Drive access and uses PKCE', () => {
    const config = { clientId: 'client', redirectUri: 'https://api.example.com/callback' };
    const url = new URL(drive.consentUrl(config, 'state', 'verifier'));
    assert.equal(url.hostname, 'accounts.google.com');
    assert.equal(url.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive.file');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), drive.hash('verifier'));
});

test('Drive token is encrypted and tied to the account and Connect owner', async (t) => {
    const config = { key: crypto.randomBytes(32), clientId: 'client', clientSecret: 'secret' };
    const refreshToken = drive.sealToken(config, 'alice', 'account-a', 'private-token');
    assert.equal(refreshToken.includes('private-token'), false);

    t.mock.method(global, 'fetch', async (_url, options) => {
        assert.equal(options.body.get('refresh_token'), 'private-token');
        return Response.json({ access_token: 'temporary-access' });
    });
    assert.equal(await drive.getAccessToken(config, {
        _id: 'alice', googleSubject: 'account-a', refreshToken,
    }), 'temporary-access');
    await assert.rejects(drive.getAccessToken(config, {
        _id: 'alice', googleSubject: 'account-b', refreshToken,
    }));
});

test('only the owner and the recipient of a sent message can read the private file', async (t) => {
    const id = '0123456789abcdef0123456789abcdef';
    const attachment = `drive-chat:${id}:file`;
    const file = { _id: id, owner: 'alice', recipient: 'bob', googleSubject: 'account-a', driveId: 'google-file', name: 'notes.txt', mime: 'application/octet-stream', kind: 'file' };
    let sent = false;
    let reads = 0;
    t.mock.method(DriveFile, 'findById', () => ({ lean: async () => file }));
    t.mock.method(DriveFile, 'exists', async (query) => (
        query._id === id && query.owner === file.owner && query.recipient === file.recipient && query.kind === file.kind
    ));
    t.mock.method(Message, 'exists', async (query) => (
        sent && query.senderId === file.owner && query.receiverId === file.recipient && query.attachment === attachment
    ));
    t.mock.method(DriveConnection, 'findOne', (query) => {
        assert.deepEqual(query, { _id: 'alice', googleSubject: 'account-a' });
        return { select: () => ({ lean: async () => ({ enabled: false, refreshToken: 'encrypted' }) }) };
    });
    t.mock.method(drive, 'settings', () => ({}));
    t.mock.method(drive, 'getAccessToken', async () => 'temporary-access');
    t.mock.method(drive, 'readFile', async () => {
        reads += 1;
        return new Response('private data');
    });

    const app = express();
    app.get('/files/:id', (req, res, next) => {
        req.profile = { _id: req.get('X-Test-Profile') };
        controller.download(req, res, next).catch(next);
    });
    const server = app.listen(0, '127.0.0.1');
    t.after(() => server.close());
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/files/${id}`;
    const read = (profile) => fetch(url, { headers: { 'X-Test-Profile': profile } });

    assert.equal(await validateAttachment(attachment, 'alice', 'bob'), true);
    assert.equal(await validateAttachment(attachment, 'alice', 'charlie'), false);
    assert.equal((await read('bob')).status, 404);
    assert.equal((await read('charlie')).status, 404);
    assert.equal(reads, 0);

    sent = true;
    const result = await read('bob');
    assert.equal(result.headers.get('content-disposition'), 'attachment; filename="notes.txt"');
    assert.equal(await result.text(), 'private data');
    assert.equal(await (await read('alice')).text(), 'private data');
    assert.equal((await read('charlie')).status, 404);
    assert.equal(reads, 2);
});

test('a small document is uploaded to Drive and bound to the selected chat', async (t) => {
    const recipient = '0123456789abcdef01234567';
    const bytes = Buffer.from('a short document');
    const connection = { googleSubject: 'account-a', enabled: true };
    const config = {};
    const Profile = require('../models/Profile');
    t.mock.method(Profile, 'exists', async (query) => query._id === recipient);
    t.mock.method(DriveConnection, 'findById', () => ({
        select: () => ({ lean: async () => connection }),
    }));
    t.mock.method(drive, 'settings', () => config);
    t.mock.method(drive, 'getAccessToken', async (usedConfig, account) => {
        assert.equal(usedConfig, config);
        assert.equal(account, connection);
        return 'temporary-access';
    });
    t.mock.method(drive, 'createFile', async (token, name, mime, payload) => {
        assert.equal(token, 'temporary-access');
        assert.equal(name, 'notes.txt');
        assert.equal(mime, 'application/octet-stream');
        assert.deepEqual(payload, bytes);
        return 'google-file';
    });

    let saved;
    t.mock.method(DriveFile, 'create', async (record) => { saved = record; });
    let response;
    const req = {
        params: { kind: 'file' },
        profile: { _id: 'alice' },
        body: { recipient },
        file: { originalname: 'notes.txt', mimetype: 'text/plain', buffer: bytes },
    };

    await controller.prepareUpload(req, {}, () => {});
    await controller.upload(req, { json: (data) => { response = data; } });
    assert.equal(saved.owner, 'alice');
    assert.equal(saved.recipient, recipient);
    assert.equal(saved.googleSubject, 'account-a');
    assert.equal(saved.driveId, 'google-file');
    assert.equal(response.secure_url, `drive-chat:${saved._id}:file`);
});
