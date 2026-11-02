// node --test utils/messageStatus.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// In-memory stand-ins for ./db, ../config/prisma and ../sockets/presence.
const messages = new Map();
let nextId = 1;
const newId = () => (nextId++).toString(16).padStart(24, "0");

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && "in" in cond) {
      return cond.in.map(String).includes(String(value));
    }
    if (typeof cond === "boolean") return Boolean(value) === cond;
    return String(value) === String(cond);
  });

const pick = (row, select) => {
  if (!select) return { ...row, _id: row.id };
  const out = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key];
  return out;
};

const fakePrisma = {
  message: {
    findMany: async ({ where, select, orderBy, take } = {}) => {
      let rows = [...messages.values()].filter((row) => matches(row, where));
      if (orderBy?.timestamp) {
        const dir = orderBy.timestamp === "desc" ? -1 : 1;
        rows.sort((a, b) => dir * (a.timestamp - b.timestamp));
      }
      if (take) rows = rows.slice(0, take);
      return rows.map((row) => pick(row, select));
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const row of messages.values()) {
        if (matches(row, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  },
};

const online = new Set();
const stub = (relative, exports) => {
  const file = require.resolve(path.join(__dirname, relative));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub("./db", { prisma: fakePrisma, isValidId: (v) => /^[0-9a-f]{24}$/.test(String(v || "")) });
stub("../config/prisma", { isMySQLReady: () => true });
stub("../sockets/presence", {
  isLocallyOnline: (id) => online.has(String(id)),
  getStatuses: async (ids) =>
    Object.fromEntries(ids.map((id) => [String(id), { isActive: online.has(String(id)) }])),
});

const status = require("./messageStatus");

const alice = "a".repeat(24);
const bob = "b".repeat(24);
const carol = "c".repeat(24);
const roomOf = (a, b) => [a, b].sort().join("_");

let clock = Date.now();
const addMessage = (senderId, receiverId, extra = {}) => {
  const row = {
    id: newId(),
    senderId,
    receiverId,
    room: roomOf(senderId, receiverId),
    message: "hi",
    isSeen: false,
    isDelivered: false,
    deliveredAt: null,
    timestamp: new Date((clock += 1000)),
    ...extra,
  };
  messages.set(row.id, row);
  return row;
};

const fakeIo = () => {
  const emitted = [];
  return {
    emitted,
    to(rooms) {
      const targets = (Array.isArray(rooms) ? rooms : [rooms]).map(String);
      return { emit: (event, payload) => emitted.push({ targets, event, payload }) };
    },
  };
};

test.beforeEach(() => {
  messages.clear();
  online.clear();
});

test("status follows seen > delivered > sent", () => {
  assert.equal(status.messageStatusOf({ isSeen: false, isDelivered: false }), "sent");
  assert.equal(status.messageStatusOf({ isSeen: false, isDelivered: true }), "delivered");
  assert.equal(status.messageStatusOf({ isSeen: true, isDelivered: false }), "seen");
});

test("opening the app delivers every pending message and tells each sender", async () => {
  const fromAlice = [addMessage(alice, bob), addMessage(alice, bob)];
  const fromCarol = addMessage(carol, bob);
  const alreadySeen = addMessage(alice, bob, { isSeen: true });
  const toSomeoneElse = addMessage(bob, alice);
  const io = fakeIo();

  const result = await status.deliverPending(io, bob);

  assert.equal(result.count, 3);
  for (const row of [...fromAlice, fromCarol]) {
    assert.equal(messages.get(row.id).isDelivered, true);
    assert.ok(messages.get(row.id).deliveredAt instanceof Date);
  }
  assert.equal(messages.get(alreadySeen.id).isDelivered, false);
  assert.equal(messages.get(toSomeoneElse.id).isDelivered, false);

  const events = io.emitted.filter((e) => e.event === "messagesDelivered");
  assert.equal(events.length, 2);
  const toAlice = events.find((e) => e.targets.includes(alice));
  assert.deepEqual(toAlice.payload.messageIds, fromAlice.map((row) => row.id));
  assert.equal(toAlice.payload.receiverId, bob);
  assert.equal(toAlice.payload.room, roomOf(alice, bob));
  const toCarol = events.find((e) => e.targets.includes(carol));
  assert.deepEqual(toCarol.payload.messageIds, [fromCarol.id]);

  // Nothing left: no second event.
  const again = await status.deliverPending(io, bob);
  assert.equal(again.count, 0);
  assert.equal(io.emitted.filter((e) => e.event === "messagesDelivered").length, 2);
});

test("the receiver can only confirm messages sent to them", async () => {
  const mine = addMessage(alice, bob);
  const notMine = addMessage(alice, carol);
  const io = fakeIo();

  const result = await status.markDelivered(io, { receiverId: bob, messageIds: [mine.id, notMine.id, "bogus"] });

  assert.equal(result.count, 1);
  assert.deepEqual(result.messageIds, [mine.id]);
  assert.equal(messages.get(mine.id).isDelivered, true);
  assert.equal(messages.get(notMine.id).isDelivered, false);
});

test("a message is delivered on send only while the receiver has the app open", async () => {
  const io = fakeIo();
  const offline = addMessage(alice, bob);
  const none = await status.deliverIfReceiverOnline(io, { ...offline, _id: offline.id });
  assert.equal(none.count, 0);
  assert.equal(messages.get(offline.id).isDelivered, false);
  assert.equal(io.emitted.length, 0);

  online.add(bob);
  const live = addMessage(alice, bob);
  const delivered = await status.deliverIfReceiverOnline(io, { ...live, _id: live.id });
  assert.equal(delivered.count, 1);
  assert.equal(messages.get(live.id).isDelivered, true);
  // Only the new message: the older one waits until Bob opens the app.
  assert.equal(messages.get(offline.id).isDelivered, false);
  assert.deepEqual(io.emitted[0].payload.messageIds, [live.id]);
  assert.deepEqual(io.emitted[0].targets, [alice]);
});

test("concurrent deliverPending calls share one run", async () => {
  addMessage(alice, bob);
  addMessage(carol, bob);
  const io = fakeIo();
  const [first, second] = await Promise.all([status.deliverPending(io, bob), status.deliverPending(io, bob)]);
  assert.equal(first, second);
  assert.equal(first.count, 2);
  assert.equal(io.emitted.filter((e) => e.event === "messagesDelivered").length, 2);
});

test("mark all as read marks every unseen message seen and delivered", async () => {
  const a1 = addMessage(alice, bob);
  const a2 = addMessage(alice, bob, { isDelivered: true, deliveredAt: new Date(1) });
  const c1 = addMessage(carol, bob);
  const sentByBob = addMessage(bob, alice);
  const io = fakeIo();

  const result = await status.markAllSeen(io, { receiverId: bob });

  assert.equal(result.count, 3);
  assert.deepEqual(result.senderIds.sort(), [alice, carol].sort());
  for (const row of [a1, a2, c1]) {
    assert.equal(messages.get(row.id).isSeen, true);
    assert.equal(messages.get(row.id).isDelivered, true);
  }
  // Already delivered rows keep their first delivery time.
  assert.equal(messages.get(a2.id).deliveredAt.getTime(), 1);
  assert.equal(messages.get(sentByBob.id).isSeen, false);

  const seen = io.emitted.filter((e) => e.event === "messageSeen");
  assert.equal(seen.length, 2);
  const forAlice = seen.find((e) => e.payload.senderId === alice);
  // The newest message of the conversation, plus every id marked.
  assert.equal(forAlice.payload.messageId, a2.id);
  assert.deepEqual(forAlice.payload.messageIds, [a1.id, a2.id]);
  assert.ok(forAlice.targets.includes(alice) && forAlice.targets.includes(bob));
  assert.equal(forAlice.payload.room, roomOf(alice, bob));

  const all = io.emitted.filter((e) => e.event === "allMessagesSeen");
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].targets, [bob]);
  assert.equal(all[0].payload.count, 3);
});

test("mark all as read can be limited to one conversation", async () => {
  const fromAlice = addMessage(alice, bob);
  const fromCarol = addMessage(carol, bob);
  const io = fakeIo();

  const result = await status.markAllSeen(io, { receiverId: bob, connectId: carol });

  assert.equal(result.count, 1);
  assert.equal(messages.get(fromCarol.id).isSeen, true);
  assert.equal(messages.get(fromAlice.id).isSeen, false);
  assert.equal(io.emitted.find((e) => e.event === "allMessagesSeen").payload.connectId, carol);
});

test("mark all as read with nothing unread sends no events", async () => {
  addMessage(alice, bob, { isSeen: true });
  const io = fakeIo();
  const result = await status.markAllSeen(io, { receiverId: bob });
  assert.equal(result.count, 0);
  assert.equal(io.emitted.length, 0);
});

test("invalid ids are ignored", async () => {
  const io = fakeIo();
  assert.equal((await status.markDelivered(io, { receiverId: "nope" })).count, 0);
  assert.equal((await status.markAllSeen(io, { receiverId: bob, connectId: "nope" })).count, 0);
  assert.equal(io.emitted.length, 0);
});
