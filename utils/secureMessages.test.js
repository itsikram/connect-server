// node --test utils/secureMessages.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// In-memory stand-ins for ./db and ./cloudinaryCleanup.
const tables = { message: new Map(), secureMessage: new Map() };
const deletedAssets = [];
let nextId = 1;
const newId = () => (nextId++).toString(16).padStart(24, "0");

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.map(String).includes(String(value));
      if ("not" in cond) return value !== cond.not;
      if ("lt" in cond) return new Date(value) < cond.lt;
      if ("gt" in cond) return new Date(value) > cond.gt;
    }
    return cond === null ? value == null : String(value) === String(cond);
  });

const model = (name) => ({
  create: async ({ data }) => {
    const row = { id: data.id || newId(), timestamp: new Date(), isSeen: false, openedAt: null, ...data };
    tables[name].set(row.id, row);
    return { ...row, _id: row.id };
  },
  findUnique: async ({ where }) => {
    const row = tables[name].get(String(where.id));
    return row ? { ...row, _id: row.id } : null;
  },
  findMany: async ({ where }) => [...tables[name].values()].filter((row) => matches(row, where)).map((row) => ({ ...row, _id: row.id })),
  updateMany: async ({ where, data }) => {
    let count = 0;
    for (const row of tables[name].values()) {
      if (matches(row, where)) {
        Object.assign(row, data);
        count += 1;
      }
    }
    return { count };
  },
  deleteMany: async ({ where }) => {
    let count = 0;
    for (const row of [...tables[name].values()]) {
      if (matches(row, where)) {
        tables[name].delete(row.id);
        count += 1;
      }
    }
    return { count };
  },
});

const fakePrisma = {
  $executeRawUnsafe: async () => 0,
  message: model("message"),
  secureMessage: model("secureMessage"),
};
const stub = (relative, exports) => {
  const file = require.resolve(path.join(__dirname, relative));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub("./db", { prisma: fakePrisma, isValidId: (v) => /^[0-9a-f]{24}$/.test(String(v || "")) });
stub("./cloudinaryCleanup", { deleteCloudinaryResources: async (urls) => deletedAssets.push(...urls.flat()) });

const secure = require("./secureMessages");

const alice = "a".repeat(24);
const bob = "b".repeat(24);
const mallory = "c".repeat(24);
const room = [alice, bob].sort().join("_");

const send = (content) =>
  secure.createSecureMessage({ room, senderId: alice, receiverId: bob, tempId: `t-${nextId}`, content });

test("stores only a placeholder in messages and encrypts the content", async () => {
  const created = await send({ text: "the vault code is 4711", attachment: "", kind: "text" });
  const row = tables.message.get(created.id);
  assert.equal(row.messageType, "secure");
  assert.equal(row.message, secure.SECURE_PLACEHOLDER);
  assert.equal(row.attachment, undefined);
  const sealed = tables.secureMessage.get(created.id);
  assert.ok(sealed.payload.startsWith("v0:") || sealed.payload.startsWith("v1:"));
  assert.ok(!sealed.payload.includes("4711"));
});

test("withSecureState reports state and never exposes content", async () => {
  const created = await send({ text: "secret", attachment: "", kind: "text" });
  const [withState] = await secure.withSecureState([{ ...tables.message.get(created.id) }]);
  assert.equal(withState.secure.state, "sealed");
  assert.equal(withState.message, secure.SECURE_PLACEHOLDER);
  assert.equal(withState.attachment, null);
});

test("only the receiver can open, and only once", async () => {
  const created = await send({ text: "open me once", attachment: "", kind: "text" });

  const bySender = await secure.openSecureMessage({ messageId: created.id, profileId: alice });
  assert.equal(bySender.ok, false);
  assert.equal(bySender.status, 403);

  const byStranger = await secure.openSecureMessage({ messageId: created.id, profileId: mallory });
  assert.equal(byStranger.ok, false);
  assert.equal(byStranger.status, 403);

  const first = await secure.openSecureMessage({ messageId: created.id, profileId: bob });
  assert.equal(first.ok, true);
  assert.equal(first.content.text, "open me once");
  assert.equal(tables.secureMessage.get(created.id).payload, "");
  assert.equal(tables.message.get(created.id).isSeen, true);

  const second = await secure.openSecureMessage({ messageId: created.id, profileId: bob });
  assert.equal(second.ok, false);
  assert.equal(second.state, "opened");

  const [withState] = await secure.withSecureState([{ ...tables.message.get(created.id) }]);
  assert.equal(withState.secure.state, "opened");
});

test("unopened messages expire and their attachments are deleted", async () => {
  const created = await send({ text: "", attachment: "https://res.cloudinary.com/x/image/upload/v1/a.jpg", kind: "image" });
  tables.secureMessage.get(created.id).expiresAt = new Date(Date.now() - 1000);

  const late = await secure.openSecureMessage({ messageId: created.id, profileId: bob });
  assert.equal(late.ok, false);
  assert.equal(late.state, "expired");

  const purged = await secure.purgeExpiredSecureMessages();
  assert.ok(purged >= 1);
  assert.equal(tables.secureMessage.get(created.id).payload, "");
  assert.ok(deletedAssets.includes("https://res.cloudinary.com/x/image/upload/v1/a.jpg"));
});

test("an opened photo stays loadable briefly, then is purged", async () => {
  const url = "https://res.cloudinary.com/x/image/upload/v1/b.jpg";
  const created = await send({ text: "look", attachment: url, kind: "image" });
  const opened = await secure.openSecureMessage({ messageId: created.id, profileId: bob });
  assert.equal(opened.content.attachment, url);
  assert.notEqual(tables.secureMessage.get(created.id).payload, "");
  assert.ok(!deletedAssets.includes(url));

  tables.secureMessage.get(created.id).expiresAt = new Date(Date.now() - 1);
  await secure.purgeExpiredSecureMessages();
  assert.ok(deletedAssets.includes(url));
});

test("deleting a message removes its secure row and attachment", async () => {
  const url = "https://res.cloudinary.com/x/image/upload/v1/c.jpg";
  const created = await send({ text: "", attachment: url, kind: "image" });
  await secure.deleteSecureContent([created.id]);
  assert.equal(tables.secureMessage.has(created.id), false);
  assert.ok(deletedAssets.includes(url));
});
