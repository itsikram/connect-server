// Tests for editing chat messages over the socket (`editMessage`) and HTTP
// (POST /api/message/edit): real Socket.IO + Express, database stubbed.
// Run: node --test sockets/messageEdit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

const stub = (relPath, exports) => {
    const resolved = require.resolve(path.join(__dirname, relPath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const fakeQuery = (value) => {
    const q = Promise.resolve(value);
    q.select = () => fakeQuery(value);
    q.populate = () => fakeQuery(value);
    q.lean = () => fakeQuery(value);
    return q;
};

const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'cccccccccccccccccccccccc';
const ROOM = [ALICE, BOB].sort().join('_');
const id = (n) => String(n).padStart(24, '0');

// In-memory Message collection with just enough of the mongoose query API
// (findById().select().populate().lean() and updateOne with $set).
const rows = new Map();
const profiles = new Map();
const updates = [];

const project = (row, fields) => {
    if (!fields) return { ...row };
    const names = fields.split(/\s+/).filter(Boolean);
    if (names.every((name) => name.startsWith('-'))) {
        const out = { ...row };
        names.forEach((name) => delete out[name.slice(1)]);
        return out;
    }
    const out = { _id: row._id };
    names.forEach((name) => {
        if (name in row) out[name] = row[name];
    });
    return out;
};

const fakeMessageQuery = (messageId) => {
    let fields = null;
    let populateParent = null;
    const run = async () => {
        const row = rows.get(String(messageId));
        if (!row) return null;
        const out = project(row, fields);
        if (populateParent && typeof out.parent === 'string') {
            const parent = rows.get(out.parent);
            out.parent = parent ? project(parent, populateParent) : null;
        }
        return out;
    };
    const query = {
        select(value) { fields = value; return query; },
        populate(options) { populateParent = options.select; return query; },
        lean() { return query; },
        then(resolve, reject) { return run().then(resolve, reject); },
    };
    return query;
};

const FakeMessage = {
    findById: (messageId) => fakeMessageQuery(messageId),
    updateOne: async (filter, update) => {
        updates.push({ filter, update });
        const row = rows.get(String(filter._id));
        if (!row || String(row.senderId) !== String(filter.senderId)) {
            return { matchedCount: 0, modifiedCount: 0 };
        }
        rows.set(String(filter._id), { ...row, ...update.$set });
        return { matchedCount: 1, modifiedCount: 1 };
    },
};
stub('../models/Message', FakeMessage);
stub('../models/Profile', {
    findById: (profileId) => fakeQuery(profiles.get(String(profileId)) || { _id: profileId, blockedUsers: [] }),
    findByIdAndUpdate: async () => null,
});
stub('../utils/pushNotifications', { sendDataPushToProfile: async () => {}, sendPushToProfile: async () => {} });
stub('../utils/chatNotifications', { notifyNewChatMessage: async () => {} });
stub('../utils/cloudinaryCleanup', { deleteCloudinaryResources: async () => {} });
stub('../middlewares/isAuth', (req, res, next) => {
    const profileId = req.headers['x-profile'];
    if (!profileId) return res.status(401).json({ message: 'Authentication token is required' });
    req.profile = { _id: profileId };
    return next();
});

const messageSocket = require('./messageSocket');
const messageRoutes = require('../Routes/messageRoutes');

const seed = () => {
    rows.clear();
    profiles.clear();
    updates.length = 0;
    const base = { room: ROOM, senderId: ALICE, receiverId: BOB, isSeen: false, timestamp: new Date('2026-10-01T10:00:00Z') };
    rows.set(id(1), { ...base, _id: id(1), message: 'helo', messageType: 'text', unseenReminderEmailSentAt: new Date() });
    rows.set(id(2), { ...base, _id: id(2), message: 'reply to helo', parent: id(1) });
    rows.set(id(3), { ...base, _id: id(3), message: 'Missed audio call', messageType: 'call', callType: 'audio', callEvent: 'missed' });
    rows.set(id(4), { ...base, _id: id(4), message: '', messageType: 'audio', attachment: 'https://cdn/voice-1.webm' });
    rows.set(id(5), { ...base, _id: id(5), message: '', attachment: 'https://cdn/photo.jpg' });
    rows.set(id(6), { ...base, _id: id(6), senderId: BOB, receiverId: ALICE, message: 'from bob' });
};

let io;
let url;
const clients = [];

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/message', messageRoutes);
    const server = http.createServer(app);
    io = new Server(server);
    app.set('io', io);
    io.on('connection', (socket) => {
        const profileId = socket.handshake.query.profile;
        socket.join(String(profileId));
        messageSocket(io, socket, profileId);
    });
    await new Promise((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    clients.forEach((c) => c.close());
    io.close();
});

test.beforeEach(seed);

const connect = async (profile) => {
    const socket = connectClient(url, { query: { profile }, transports: ['websocket'], forceNew: true });
    clients.push(socket);
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
    });
    return socket;
};

const once = (socket, event, ms = 2000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
        socket.once(event, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });

// Resolves with every `event` the socket receives within `ms`.
const collect = (socket, event, ms = 300) =>
    new Promise((resolve) => {
        const seen = [];
        const handler = (data) => seen.push(data);
        socket.on(event, handler);
        setTimeout(() => {
            socket.off(event, handler);
            resolve(seen);
        }, ms);
    });

const emitWithAck = (socket, event, data) =>
    new Promise((resolve) => socket.emit(event, data, resolve));

const postEdit = async (profile, body) => {
    const res = await fetch(`${url}/api/message/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(profile ? { 'x-profile': profile } : {}) },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
};

test('sender edits a text message: both participants get messageEdited, others do not', async () => {
    const [alice, bob, carol] = await Promise.all([connect(ALICE), connect(BOB), connect(CAROL)]);
    const aliceEvent = once(alice, 'messageEdited');
    const bobEvent = once(bob, 'messageEdited');
    const carolEvents = collect(carol, 'messageEdited');

    const ack = await emitWithAck(alice, 'editMessage', { messageId: id(1), message: '  hello  ' });

    assert.equal(ack.ok, true);
    assert.equal(ack.changed, true);
    assert.equal(ack.updatedMessage.message, 'hello');
    assert.equal(ack.updatedMessage.isEdited, true);
    assert.ok(ack.updatedMessage.editedAt);
    assert.equal(ack.updatedMessage.unseenReminderEmailSentAt, undefined, 'internal fields stay on the server');

    for (const payload of [await aliceEvent, await bobEvent]) {
        assert.equal(payload.messageId, id(1));
        assert.equal(payload._id, id(1));
        assert.equal(payload.message, 'hello');
        assert.equal(payload.isEdited, true);
        assert.equal(payload.senderId, ALICE);
        assert.equal(payload.receiverId, BOB);
        assert.equal(payload.room, ROOM);
        assert.ok(payload.editedAt);
        assert.equal(payload.updatedMessage.message, 'hello');
    }
    assert.deepEqual(await carolEvents, []);

    const stored = rows.get(id(1));
    assert.equal(stored.message, 'hello');
    assert.equal(stored.isEdited, true);
    assert.ok(stored.editedAt instanceof Date);
    // Only the edit fields are written; everything else is left alone.
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(updates[0].update), ['$set']);
    assert.deepEqual(Object.keys(updates[0].update.$set).sort(), ['editedAt', 'isEdited', 'message']);
    assert.deepEqual(updates[0].filter, { _id: id(1), senderId: ALICE });
    assert.equal(stored.isSeen, false);
    assert.equal(stored.messageType, 'text');
});

test('a message deleted while being edited reports 404', async () => {
    const alice = await connect(ALICE);
    const realUpdateOne = FakeMessage.updateOne;
    FakeMessage.updateOne = async (filter, update) => {
        rows.delete(String(filter._id));
        return realUpdateOne(filter, update);
    };
    try {
        const ack = await emitWithAck(alice, 'editMessage', { messageId: id(1), message: 'too late' });
        assert.equal(ack.ok, false);
        assert.equal(ack.status, 404);
    } finally {
        FakeMessage.updateOne = realUpdateOne;
    }
});

test('messages without a messageType (legacy text) and replies can be edited', async () => {
    const alice = await connect(ALICE);
    const ack = await emitWithAck(alice, 'editMessage', { messageId: id(2), message: 'edited reply' });
    assert.equal(ack.ok, true);
    assert.equal(ack.updatedMessage.message, 'edited reply');
    assert.equal(ack.updatedMessage.parent.message, 'helo', 'parent stays populated for reply quotes');
});

test('only the sender can edit', async () => {
    const bob = await connect(BOB);
    const ack = await emitWithAck(bob, 'editMessage', { messageId: id(1), message: 'hijacked' });
    assert.equal(ack.ok, false);
    assert.equal(ack.status, 403);
    assert.equal(rows.get(id(1)).message, 'helo');
    assert.equal(rows.get(id(1)).isEdited, undefined);
});

test('rejects empty text, bad ids, missing messages and non-text messages', async () => {
    const alice = await connect(ALICE);
    const cases = [
        [{ messageId: id(1), message: '   ' }, 400],
        [{ messageId: id(1) }, 400],
        [{ messageId: 'not-an-id', message: 'x' }, 400],
        [{ message: 'x' }, 400],
        [{ messageId: id(99), message: 'x' }, 404],
        [{ messageId: id(3), message: 'not a call' }, 400],
        [{ messageId: id(4), message: 'not a voice note' }, 400],
        [{ messageId: id(5), message: 'caption added' }, 400],
        [{ messageId: id(1), message: 'x'.repeat(10001) }, 400],
    ];
    for (const [data, status] of cases) {
        const ack = await emitWithAck(alice, 'editMessage', data);
        assert.equal(ack.ok, false, JSON.stringify(data).slice(0, 80));
        assert.equal(ack.status, status, JSON.stringify(data).slice(0, 80));
        assert.equal(typeof ack.error, 'string');
    }
    const garbage = await emitWithAck(alice, 'editMessage', 'just a string');
    assert.equal(garbage.ok, false);
    assert.equal(garbage.status, 400);
    assert.equal(rows.get(id(1)).message, 'helo');
});

test('saving the same text is a no-op: no event, not marked edited', async () => {
    const [alice, bob] = await Promise.all([connect(ALICE), connect(BOB)]);
    const bobEvents = collect(bob, 'messageEdited');
    const ack = await emitWithAck(alice, 'editMessage', { messageId: id(1), message: ' helo ' });
    assert.equal(ack.ok, true);
    assert.equal(ack.changed, false);
    assert.equal(ack.updatedMessage.message, 'helo');
    assert.deepEqual(await bobEvents, []);
    assert.equal(rows.get(id(1)).isEdited, undefined);
});

test('no edits while either side has blocked the other', async () => {
    const alice = await connect(ALICE);
    profiles.set(BOB, { _id: BOB, blockedUsers: [ALICE] });
    let ack = await emitWithAck(alice, 'editMessage', { messageId: id(1), message: 'after block' });
    assert.equal(ack.ok, false);
    assert.equal(ack.status, 403);

    profiles.set(BOB, { _id: BOB, blockedUsers: [] });
    profiles.set(ALICE, { _id: ALICE, blockedUsers: [BOB] });
    ack = await emitWithAck(alice, 'editMessage', { messageId: id(1), message: 'after block' });
    assert.equal(ack.status, 403);
    assert.equal(rows.get(id(1)).message, 'helo');
});

test('HTTP: POST /api/message/edit edits and notifies the other participant', async () => {
    const bob = await connect(BOB);
    const bobEvent = once(bob, 'messageEdited');

    const res = await postEdit(ALICE, { messageId: id(1), message: 'hello over http' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.message, 'hello over http');
    assert.equal(res.body.data.isEdited, true);

    const payload = await bobEvent;
    assert.equal(payload.messageId, id(1));
    assert.equal(payload.message, 'hello over http');
});

test('HTTP: errors map to status codes', async () => {
    assert.equal((await postEdit(null, { messageId: id(1), message: 'x' })).status, 401);
    assert.equal((await postEdit(BOB, { messageId: id(1), message: 'x' })).status, 403);
    assert.equal((await postEdit(ALICE, { messageId: id(1), message: '' })).status, 400);
    assert.equal((await postEdit(ALICE, { messageId: id(42), message: 'x' })).status, 404);
    const forbidden = await postEdit(ALICE, { messageId: id(6), message: 'not mine' });
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.body.message, /own messages/);
    assert.equal(rows.get(id(6)).message, 'from bob');
});
