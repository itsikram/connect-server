// Tests for sending chat messages over Socket.IO (sendMessage) and HTTP
// (POST /message/send): real Socket.IO server + clients, database and push
// fan-out stubbed with an in-memory fake that records every query and how
// many ran at once. Run: node --test sockets/messageSocket.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const QUERY_DELAY_MS = 25;

// ── in-memory database ──────────────────────────────────────────────────
const db = { blocks: [], messages: [], failBlocks: false, failProfile: false };
const calls = [];
let inFlight = 0;
let maxInFlight = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const query = (name, fn) => async (args = {}) => {
    calls.push({ name, args });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
        await sleep(QUERY_DELAY_MS);
        return fn(args);
    } finally {
        inFlight -= 1;
    }
};
const resetCounters = () => {
    calls.length = 0;
    maxInFlight = 0;
};
const callsOf = (name) => calls.filter((call) => call.name === name);

const users = {
    [A]: { id: 'ua', firstName: 'Alice', surname: 'A', password: 'hash-a', resetPasswordToken: 'reset-a', resetPasswordExpire: new Date() },
    [B]: { id: 'ub', firstName: 'Bob', surname: 'B', password: 'hash-b', resetPasswordToken: null, resetPasswordExpire: null },
};
const withParent = (row, include) => {
    if (!row) return null;
    const out = { ...row, _id: row.id };
    if (include?.parentDoc) {
        const parent = db.messages.find((m) => m.id === row.parent);
        out.parentDoc = parent ? { ...parent, _id: parent.id } : null;
    }
    return out;
};
const prisma = {
    block: {
        findMany: query('block.findMany', ({ where }) => {
            if (db.failBlocks) throw new Error('block table unavailable');
            return db.blocks
                .filter((b) => where.OR.some((c) => c.profile === b.profile && c.blocked === b.blocked))
                .map((b) => ({ profile: b.profile }));
        }),
    },
    message: {
        findFirst: query('message.findFirst', ({ where, include }) =>
            withParent(db.messages.find((m) => Object.entries(where).every(([k, v]) => m[k] === v)), include)),
        create: query('message.create', ({ data, include }) => {
            const row = {
                id: String(db.messages.length + 1).padStart(24, 'c'),
                isSeen: false,
                timestamp: new Date(),
                parent: null,
                ...data,
            };
            db.messages.push(row);
            return withParent(row, include);
        }),
    },
    profile: {
        findUnique: query('profile.findUnique', ({ where, include }) => {
            if (db.failProfile) throw new Error('profile table unavailable');
            const user = users[where.id];
            if (!user) return null;
            const profile = { id: where.id, _id: where.id, profilePic: `${where.id}.png`, user: user.id, deviceTokens: [] };
            if (include?.userDoc) {
                const omit = include.userDoc.omit || {};
                profile.userDoc = Object.fromEntries(Object.entries(user).filter(([key]) => !omit[key]));
            }
            return profile;
        }),
        updateMany: query('profile.updateMany', () => ({ count: 1 })),
    },
};

// ── module stubs ────────────────────────────────────────────────────────
const stub = (relPath, exports) => {
    const resolved = require.resolve(path.join(__dirname, relPath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const populated = (rows, ...fields) => {
    const apply = (row) => {
        if (!row || typeof row !== 'object') return row;
        for (const field of fields) {
            const key = `${field}Doc`;
            if (key in row) {
                row[field] = row[key];
                delete row[key];
            }
        }
        return row;
    };
    return Array.isArray(rows) ? rows.map(apply) : apply(rows);
};
const lastActiveWrites = [];
const notifications = [];
let notifyGate = null;

stub('../utils/db', { prisma, populated, isValidId: (id) => /^[a-f\d]{24}$/i.test(String(id || '')) });
stub('../config/prisma', { prisma, isMySQLReady: () => true });
stub('./socketAuth', { profileIdOf: (socket) => socket.handshake.query.profile });
stub('../utils/checkIsActive', async () => false);
stub('../utils/updateLastActive', async (id) => { lastActiveWrites.push(String(id)); });
stub('../utils/pushNotifications', { sendDataPushToProfile: async () => {} });
stub('../utils/chatNotifications', {
    notifyNewChatMessage: async (io, payload) => {
        notifications.push(payload);
        if (notifyGate) await notifyGate;
    },
});
stub('../utils/messageStatus', {
    deliverPending: async () => {},
    deliverIfReceiverOnline: async () => {},
    markDelivered: async () => {},
    markDeliveredWithSeen: async () => {},
    markAllSeen: async () => {},
});
stub('../utils/secureMessages', {
    isSecureRequest: () => false,
    isSecureMessage: () => false,
    prepareSecureContent: () => ({ ok: false }),
    createSecureMessage: async () => null,
    withSecureState: async (messages) => messages,
    openSecureMessage: async () => ({ ok: false }),
    deleteSecureContent: async () => {},
});
stub('../utils/conversationPage', { findConversationPage: async () => [], latestMessageIdsByPeer: async () => [] });
stub('../utils/cloudinaryCleanup', { deleteCloudinaryResources: async () => {} });
stub('./presence', { statusFromProfile: () => ({ isActive: false }) });

const messageSocket = require('./messageSocket');
const messageController = require('../controllers/messageController');

// ── socket server ───────────────────────────────────────────────────────
let io;
let url;
let alice;
let bob;
const clients = [];

test.after(() => {
    clients.forEach((c) => c.close());
    io.close();
});

test.beforeEach(() => {
    db.blocks = [];
    db.failBlocks = false;
    db.failProfile = false;
    lastActiveWrites.length = 0;
    notifications.length = 0;
    notifyGate = null;
    resetCounters();
});

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
const send = (socket, payload) => new Promise((resolve) => socket.emit('sendMessage', payload, resolve));

test.before(async () => {
    const server = http.createServer();
    io = new Server(server);
    io.on('connection', (socket) => {
        const profileId = socket.handshake.query.profile;
        socket.join(String(profileId));
        messageSocket(io, socket, profileId);
    });
    await new Promise((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    alice = await connect(A);
    bob = await connect(B);
});

// ── socket sendMessage ──────────────────────────────────────────────────
test('a message is acked and delivered after one round of parallel lookups', async () => {
    const delivered = once(bob, 'newMessageToUser');
    const sent = once(alice, 'messageSent');
    const ack = await send(alice, { receiverId: B, message: 'hello', tempId: 't-1' });
    const toBob = await delivered;
    await sent;

    assert.equal(ack.ok, true);
    assert.equal(ack.tempId, 't-1');
    assert.equal(ack.updatedMessage.message, 'hello');
    assert.equal(ack.updatedMessage.senderId, A);
    assert.equal(ack.updatedMessage.room, [A, B].sort().join('_'));
    assert.equal(ack.updatedMessage.senderName, 'Alice A');
    assert.equal(ack.updatedMessage.senderPP, `${A}.png`);
    assert.equal(toBob.updatedMessage._id, ack.updatedMessage._id);

    // Block check, duplicate check and sender profile ran at the same time.
    assert.ok(maxInFlight >= 3, `expected 3 parallel lookups, saw ${maxInFlight}`);
    // The new row comes back from create (with its parent); it is not read again.
    assert.equal(callsOf('message.create').length, 1);
    assert.deepEqual(callsOf('message.create')[0].args.include, { parentDoc: true });
    assert.equal(callsOf('message.findFirst').length, 1, 'only the tempId lookup');
    // Last-active bookkeeping happens, but after the ack.
    assert.deepEqual(lastActiveWrites, [A]);
    assert.equal(notifications.length, 1);
});

test('the sender profile sent to the receiver never includes the password hash or reset token', async () => {
    const delivered = once(bob, 'newMessageToUser');
    await send(alice, { receiverId: B, message: 'secret?', tempId: 't-2' });
    const { connectProfile } = await delivered;
    assert.equal(connectProfile.user.firstName, 'Alice');
    assert.equal('password' in connectProfile.user, false);
    assert.equal('resetPasswordToken' in connectProfile.user, false);
    assert.equal('resetPasswordExpire' in connectProfile.user, false);
    assert.deepEqual(callsOf('profile.findUnique')[0].args.include.userDoc.omit, {
        password: true,
        resetPasswordToken: true,
        resetPasswordExpire: true,
    });
});

test('a reply carries its parent message', async () => {
    const first = await send(alice, { receiverId: B, message: 'original', tempId: 't-3' });
    const reply = await send(bob, { receiverId: A, message: 'reply', tempId: 't-4', parent: first.updatedMessage._id });
    assert.equal(reply.ok, true);
    assert.equal(reply.updatedMessage.parent._id, first.updatedMessage._id);
    assert.equal(reply.updatedMessage.parent.message, 'original');
    assert.equal('parentDoc' in reply.updatedMessage, false);
});

test('a retried tempId returns the existing message instead of creating another', async () => {
    const first = await send(alice, { receiverId: B, message: 'once', tempId: 't-5' });
    resetCounters();
    const again = await send(alice, { receiverId: B, message: 'once', tempId: 't-5' });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.updatedMessage._id, first.updatedMessage._id);
    assert.equal(callsOf('message.create').length, 0);
});

test('blocked users cannot message each other', async () => {
    db.blocks.push({ profile: B, blocked: A });
    const notice = once(alice, 'message_blocked');
    const ack = await send(alice, { receiverId: B, message: 'hi', tempId: 't-6' });
    assert.equal(ack.ok, false);
    assert.equal(ack.blocked, true);
    assert.equal(ack.reason, 'You are blocked by this user');
    assert.equal((await notice).tempId, 't-6');
    assert.equal(callsOf('message.create').length, 0);
});

test('a failed block check is reported and nothing is sent', async () => {
    db.failBlocks = true;
    const ack = await send(alice, { receiverId: B, message: 'hi', tempId: 't-7' });
    assert.deepEqual(ack, { ok: false, error: 'Could not verify block status' });
    assert.equal(callsOf('message.create').length, 0);
});

test('a failed sender profile lookup is reported', async () => {
    db.failProfile = true;
    const ack = await send(alice, { receiverId: B, message: 'hi', tempId: 't-8' });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'profile table unavailable');
});

test('an invalid receiver is rejected', async () => {
    const ack = await send(alice, { receiverId: 'nope', message: 'hi', tempId: 't-9' });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'senderId and receiverId are required');
    assert.equal(callsOf('message.create').length, 0);
});

// ── HTTP POST /message/send ─────────────────────────────────────────────
const httpSend = (body) =>
    new Promise((resolve, reject) => {
        const req = { body, profile: { _id: A }, app: { get: () => io } };
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve({ status: this.statusCode, payload });
                return this;
            },
        };
        messageController.sendMessage(req, res, reject);
    });

test('HTTP send responds without waiting for push notifications', async () => {
    let release;
    notifyGate = new Promise((resolve) => { release = resolve; });
    const delivered = once(bob, 'newMessageToUser');
    const { status, payload } = await httpSend({ receiverId: B, message: 'via http', tempId: 'h-1' });
    // The response came back while the notification fan-out is still pending.
    assert.equal(status, 200);
    assert.equal(payload.data.message, 'via http');
    assert.equal(notifications.length, 1);
    release();
    const toBob = await delivered;
    assert.equal(toBob.updatedMessage._id, payload.data._id);
    assert.equal('password' in toBob.connectProfile.user, false);
    assert.ok(maxInFlight >= 3, `expected 3 parallel lookups, saw ${maxInFlight}`);
    assert.equal(callsOf('message.findFirst').length, 1, 'only the tempId lookup');
});

test('HTTP send returns the existing copy for a retried tempId', async () => {
    const first = await httpSend({ receiverId: B, message: 'idempotent', tempId: 'h-2' });
    resetCounters();
    const again = await httpSend({ receiverId: B, message: 'idempotent', tempId: 'h-2' });
    assert.equal(again.payload.duplicate, true);
    assert.equal(again.payload.data._id, first.payload.data._id);
    assert.equal(callsOf('message.create').length, 0);
});

test('HTTP send refuses blocked conversations', async () => {
    db.blocks.push({ profile: A, blocked: B });
    const { status, payload } = await httpSend({ receiverId: B, message: 'hi', tempId: 'h-3' });
    assert.equal(status, 403);
    assert.equal(payload.reason, 'You blocked this user');
    assert.equal(callsOf('message.create').length, 0);
});
