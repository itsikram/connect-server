// Unit tests for utils/conversationPage.js with the database stubbed: the SQL
// it builds (both directions, depth, LIMIT / OFFSET, `before`) and that rows
// come back in the order the id query chose. The same queries were checked
// against MySQL/MariaDB for identical results to the old OR query.
// Run: node --test utils/conversationPage.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Prisma } = require('@prisma/client');

const rawCalls = [];
const findManyCalls = [];
let rawResult = [];
let findManyResult = [];

const prisma = {
    $queryRaw: async (strings, ...values) => {
        const query = Prisma.sql(strings, ...values);
        rawCalls.push({ sql: query.sql.replace(/\s+/g, ' ').trim(), values: query.values });
        return rawResult;
    },
    message: {
        findMany: async (args) => {
            findManyCalls.push(args);
            return findManyResult;
        },
    },
};
const resolved = require.resolve(path.join(__dirname, '../config/prisma'));
require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { prisma } };

const { conversationPageIds, findConversationPage, latestMessageIdsByPeer } = require('./conversationPage');

test.beforeEach(() => {
    rawCalls.length = 0;
    findManyCalls.length = 0;
    rawResult = [];
    findManyResult = [];
});

test('reads each direction in index order and merges only what the page needs', async () => {
    rawResult = [{ id: 'm3' }, { id: 'm2' }];
    const ids = await conversationPageIds('me', 'you', { skip: 30, take: 21 });
    assert.deepEqual(ids, ['m3', 'm2']);
    const [{ sql, values }] = rawCalls;
    assert.match(sql, /^\(SELECT id, timestamp FROM messages WHERE senderId = \? AND receiverId = \? ORDER BY timestamp DESC, id DESC LIMIT \?\) UNION ALL \(SELECT id, timestamp FROM messages WHERE senderId = \? AND receiverId = \? ORDER BY timestamp DESC, id DESC LIMIT \?\) ORDER BY timestamp DESC, id DESC LIMIT \? OFFSET \?$/);
    // each direction: newest skip + take rows; then the page itself
    assert.deepEqual(values, ['me', 'you', 51, 'you', 'me', 51, 21, 30]);
});

test('`before` limits both directions to older messages', async () => {
    const before = new Date('2026-01-01T00:00:00Z');
    await conversationPageIds('me', 'you', { take: 10, before });
    const [{ sql, values }] = rawCalls;
    assert.equal((sql.match(/AND timestamp < \?/g) || []).length, 2);
    assert.deepEqual(values, ['me', 'you', before, 10, 'you', 'me', before, 10, 10, 0]);
});

test('a chat with yourself reads one direction', async () => {
    await conversationPageIds('me', 'me', { skip: 5, take: 20 });
    const [{ sql, values }] = rawCalls;
    assert.doesNotMatch(sql, /UNION/);
    assert.match(sql, /LIMIT \? OFFSET \?$/);
    assert.deepEqual(values, ['me', 'me', 20, 5]);
});

test('bad skip / take values are clamped, and an empty page runs no query', async () => {
    assert.deepEqual(await conversationPageIds('me', 'you', { take: 0 }), []);
    assert.deepEqual(await conversationPageIds('me', 'you', { take: 'x' }), []);
    assert.equal(rawCalls.length, 0);
    await conversationPageIds('me', 'you', { skip: -4, take: 2.9 });
    assert.deepEqual(rawCalls[0].values.slice(-2), [2, 0]);
});

test('findConversationPage loads the rows by id, in the id query order, with the caller options', async () => {
    rawResult = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    findManyResult = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const include = { parentDoc: true };
    const omit = { unseenReminderEmailSentAt: true };
    const rows = await findConversationPage('me', 'you', { take: 3, include, omit });
    assert.deepEqual(rows.map((row) => row.id), ['c', 'a', 'b']);
    assert.deepEqual(findManyCalls, [{ include, omit, where: { id: { in: ['c', 'a', 'b'] } } }]);
});

test('findConversationPage skips the row load for an empty page', async () => {
    assert.deepEqual(await findConversationPage('me', 'you', { take: 20 }), []);
    assert.equal(findManyCalls.length, 0);
});

test('latest message per peer: sent groups by receiver, received groups by sender', async () => {
    rawResult = [{ id: 'x' }, { id: 'y' }];
    assert.deepEqual(await latestMessageIdsByPeer('me', 'sent'), ['x', 'y']);
    assert.deepEqual(await latestMessageIdsByPeer('me', 'received'), ['x', 'y']);
    const [sent, received] = rawCalls;
    assert.match(sent.sql, /MAX\(timestamp\) AS ts FROM messages WHERE senderId = \? GROUP BY receiverId/);
    assert.match(sent.sql, /ON m\.senderId = \? AND m\.receiverId = latest\.peer AND m\.timestamp = latest\.ts$/);
    assert.match(received.sql, /MAX\(timestamp\) AS ts FROM messages WHERE receiverId = \? GROUP BY senderId/);
    assert.match(received.sql, /ON m\.receiverId = \? AND m\.senderId = latest\.peer AND m\.timestamp = latest\.ts$/);
    assert.deepEqual(sent.values, ['me', 'me']);
});
