// End-to-end tests for call signaling: real Socket.IO server + clients, with
// the database and push senders stubbed. Run: node --test sockets/callingSocket.test.js
process.env.CALL_RING_TIMEOUT_MS = '400';
process.env.CALLER_DISCONNECT_GRACE_MS = '150';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

const pushes = [];
const savedMessages = [];

const stub = (relPath, exports) => {
    const resolved = require.resolve(path.join(__dirname, relPath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const fakeQuery = (value) => {
    const q = Promise.resolve(value);
    q.select = () => fakeQuery(value);
    q.populate = () => fakeQuery(value);
    return q;
};

stub('../models/Profile', {
    findById: (id) => fakeQuery({ _id: id, fullName: `User ${id}`, profilePic: '', user: {} }),
});
function FakeMessage(doc) {
    Object.assign(this, doc, { _id: `m${savedMessages.length + 1}` });
}
FakeMessage.prototype.save = async function save() { savedMessages.push(this); return this; };
FakeMessage.findOne = ({ _id }) => fakeQuery(savedMessages.find((m) => m._id === _id));
stub('../models/Message', FakeMessage);
stub('../utils/pushNotifications', { sendPushToProfile: async (to, p) => pushes.push({ kind: 'fcm', to, p }) });
stub('../utils/webPush', { sendWebPushToProfile: async (to, p) => pushes.push({ kind: 'web', to, p }) });
stub('../utils/ringtone', { getIncomingCallAlertForProfile: async () => ({ id: 1, webSrc: '/r.mp3' }) });

const callingSocket = require('./callingSocket');

let io;
let url;
const clients = [];

test.before(async () => {
    const server = http.createServer();
    io = new Server(server);
    io.on('connection', (socket) => {
        const profileId = socket.handshake.query.profile;
        socket.join(String(profileId));
        callingSocket(io, socket, profileId, new Map());
    });
    await new Promise((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    clients.forEach((c) => c.close());
    io.close();
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

const noEvent = (socket, event, ms = 300) =>
    new Promise((resolve, reject) => {
        const handler = () => reject(new Error(`unexpected ${event}`));
        socket.once(event, handler);
        setTimeout(() => {
            socket.off(event, handler);
            resolve();
        }, ms);
    });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('audio call: ring, answer on one device, stop ringing on the other, end and log duration', async () => {
    const caller = await connect('a1');
    const calleeWeb = await connect('b1');
    const calleePhone = await connect('b1');
    const channelName = 'a1-b1';

    const ringWeb = once(calleeWeb, 'incoming-audio-call');
    const ringPhone = once(calleePhone, 'incoming-audio-call');
    caller.emit('audio-call', { to: 'b1', channelName, isAudio: true });
    const [incoming] = await Promise.all([ringWeb, ringPhone]);
    assert.equal(incoming.from, 'a1');
    assert.equal(incoming.channelName, channelName);
    assert.equal(incoming.isAudio, true);
    assert.equal(incoming.callerName, 'User a1');

    // "Ringing..." status reaches the caller.
    const status = once(caller, 'updated-call-status');
    calleeWeb.emit('update-call-status', { to: 'a1', status: 'Ringing...', channelName });
    assert.equal((await status).status, 'Ringing...');

    const accepted = once(caller, 'call-accepted');
    const echo = once(calleeWeb, 'call-accepted');
    const phoneStops = once(calleePhone, 'audio-call-cancelled');
    calleeWeb.emit('answer-call', { to: 'a1', channelName, isAudio: true });
    const acc = await accepted;
    assert.equal(acc.channelName, channelName);
    assert.equal(acc.isAudio, true);
    assert.equal((await echo).callerId, 'a1');
    assert.equal((await phoneStops).reason, 'answered_elsewhere');

    // A late duplicate reject from the other device must not kill the call.
    await Promise.all([
        noEvent(caller, 'audio-call-rejected'),
        calleePhone.emit('audio-call-reject', { to: 'a1', channelName }),
    ]);

    await sleep(1100);
    const ended = once(calleeWeb, 'audio-call-ended');
    caller.emit('audio-call-end', { to: 'b1', channelName });
    assert.equal((await ended).channelName, channelName);
    await sleep(50);
    const log = savedMessages.filter((m) => m.room === 'a1_b1').pop();
    assert.equal(log.callEvent, 'ended');
    assert.equal(log.callType, 'audio');
    assert.ok(log.duration >= 1, `duration ${log.duration}`);
});

test('video call declined: caller hears "declined", missed-call log written', async () => {
    const caller = await connect('a2');
    const callee = await connect('b2');
    const channelName = 'a2-b2';
    const ring = once(callee, 'incoming-video-call');
    caller.emit('video-call', { to: 'b2', channelName, isAudio: false });
    const incoming = await ring;
    assert.equal(incoming.isAudio, false);

    const rejected = once(caller, 'video-call-rejected');
    callee.emit('video-call-reject', { to: 'a2', channelName });
    const r = await rejected;
    assert.equal(r.reason, 'declined');
    assert.equal(r.channelName, channelName);
    await sleep(50);
    const log = savedMessages.filter((m) => m.room === 'a2_b2').pop();
    assert.equal(log.callEvent, 'missed');
    assert.equal(log.callType, 'video');
});

test('client-side busy reject is reported as "busy"', async () => {
    const caller = await connect('a3');
    const callee = await connect('b3');
    const channelName = 'a3-b3';
    const ring = once(callee, 'incoming-audio-call');
    caller.emit('audio-call', { to: 'b3', channelName, isAudio: true });
    await ring;
    const rejected = once(caller, 'audio-call-rejected');
    callee.emit('audio-call-reject', { to: 'a3', channelName, reason: 'busy' });
    assert.equal((await rejected).reason, 'busy');
});

test('calling someone already on a call: instant busy, callee not rung, missed call logged', async () => {
    const x = await connect('x4');
    const y = await connect('y4');
    const z = await connect('z4');
    const ring = once(y, 'incoming-video-call');
    x.emit('video-call', { to: 'y4', channelName: 'x4-y4', isAudio: false });
    await ring;
    y.emit('answer-call', { to: 'x4', channelName: 'x4-y4', isAudio: false });
    await once(x, 'call-accepted');

    const busy = once(z, 'audio-call-rejected');
    const notRung = noEvent(y, 'incoming-audio-call', 400);
    z.emit('audio-call', { to: 'y4', channelName: 'z4-y4', isAudio: true });
    const r = await busy;
    assert.equal(r.reason, 'busy');
    assert.equal(r.channelName, 'z4-y4');
    await notRung;
    await sleep(50);
    assert.ok(pushes.some((p) => p.to === 'y4' && /Missed audio call/.test(p.p.title)));

    // Once that call ends, y4 can be called again.
    x.emit('video-call-end', { to: 'y4', channelName: 'x4-y4' });
    await once(y, 'video-call-ended');
    const ringAgain = once(y, 'incoming-audio-call');
    z.emit('audio-call', { to: 'y4', channelName: 'z4-y4', isAudio: true });
    await ringAgain;
    z.emit('audio-call-cancel', { to: 'y4', channelName: 'z4-y4' });
    await once(y, 'audio-call-cancelled');
});

test('stale accepted call with a disconnected peer does not make someone busy', async () => {
    const p = await connect('p5');
    const q = await connect('q5');
    const r = await connect('r5');
    const ring = once(q, 'incoming-audio-call');
    p.emit('audio-call', { to: 'q5', channelName: 'p5-q5', isAudio: true });
    await ring;
    q.emit('answer-call', { to: 'p5', channelName: 'p5-q5', isAudio: true });
    await once(p, 'call-accepted');
    // p's app is killed mid-call: no end event ever arrives.
    p.close();
    await sleep(100);
    const rings = once(q, 'incoming-video-call');
    r.emit('video-call', { to: 'q5', channelName: 'r5-q5', isAudio: false });
    await rings;
    r.emit('video-call-cancel', { to: 'q5', channelName: 'r5-q5' });
});

test('caller cancels while ringing: every callee device stops, missed call pushed', async () => {
    const caller = await connect('a6');
    const callee = await connect('b6');
    const ring = once(callee, 'incoming-audio-call');
    caller.emit('audio-call', { to: 'b6', channelName: 'a6-b6', isAudio: true });
    await ring;
    const cancelled = once(callee, 'audio-call-cancelled');
    caller.emit('audio-call-cancel', { to: 'b6', channelName: 'a6-b6' });
    assert.equal((await cancelled).channelName, 'a6-b6');
    await sleep(50);
    assert.ok(pushes.some((p) => p.to === 'b6' && p.p.data?.type === 'missed_call'));
});

test('unanswered call times out: caller gets call-not-accepted, callee stops ringing', async () => {
    const caller = await connect('a7');
    const callee = await connect('b7');
    const ring = once(callee, 'incoming-video-call');
    caller.emit('video-call', { to: 'b7', channelName: 'a7-b7', isAudio: false });
    await ring;
    const [notAccepted, cancelled] = await Promise.all([
        once(caller, 'call-not-accepted'),
        once(callee, 'video-call-cancelled'),
    ]);
    assert.equal(notAccepted.isAudio, false);
    assert.equal(cancelled.reason, 'timeout');
});

test('caller disconnects while ringing: callee stops ringing after the grace period', async () => {
    const caller = await connect('a8');
    const callee = await connect('b8');
    const ring = once(callee, 'incoming-audio-call');
    caller.emit('audio-call', { to: 'b8', channelName: 'a8-b8', isAudio: true });
    await ring;
    const cancelled = once(callee, 'audio-call-cancelled');
    caller.close();
    assert.equal((await cancelled).reason, 'caller_disconnected');
});

test('caller reconnecting within the grace period keeps the call ringing', async () => {
    const caller = await connect('a9');
    const callee = await connect('b9');
    const ring = once(callee, 'incoming-audio-call');
    caller.emit('audio-call', { to: 'b9', channelName: 'a9-b9', isAudio: true });
    await ring;
    caller.close();
    const back = await connect('a9');
    await noEvent(callee, 'audio-call-cancelled', 300);
    const accepted = once(back, 'call-accepted');
    callee.emit('answer-call', { to: 'a9', channelName: 'a9-b9', isAudio: true });
    await accepted;
    back.emit('audio-call-end', { to: 'b9', channelName: 'a9-b9' });
    await once(callee, 'audio-call-ended');
});

test('offline callee: caller sees "Calling..." and the callee gets a push', async () => {
    const caller = await connect('a10');
    const status = once(caller, 'updated-call-status');
    caller.emit('video-call', { to: 'b10', channelName: 'a10-b10', isAudio: false });
    const s = await status;
    assert.equal(s.from, 'b10');
    assert.equal(s.status, 'Calling...');
    await sleep(50);
    assert.ok(pushes.some((p) => p.to === 'b10' && p.p.data?.type === 'incoming_call'));
    caller.emit('video-call-cancel', { to: 'b10', channelName: 'a10-b10' });
});
