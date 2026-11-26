const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

process.env.JWT_SECRET_KEY = "face-login-test-secret";
process.env.FACE_SERVICE_API_KEY = "server-key";
process.env.FACE_ANALYZE_URL = "https://face.example.test/face-api";

// ── In-memory stand-in for the MySQL tables face login touches ──
const db = { faceencodings: [], users: new Map(), profiles: new Map() };
let nextId = 1;
const prisma = {
  faceEncoding: {
    findMany: async ({ where }) =>
      db.faceencodings.filter((row) => (where?.profile?.not === null ? row.profile !== null : true)),
    deleteMany: async ({ where }) => {
      const before = db.faceencodings.length;
      db.faceencodings = db.faceencodings.filter((row) => row.profile !== where.profile);
      return { count: before - db.faceencodings.length };
    },
    create: async ({ data }) => {
      const row = { id: `fe${nextId++}`, email: null, ...data };
      db.faceencodings.push(row);
      return row;
    },
  },
  profile: {
    findUnique: async ({ where }) => {
      const profile = db.profiles.get(where.id);
      return profile ? { ...profile, userDoc: db.users.get(profile.user) } : null;
    },
  },
  user: {
    update: async ({ where, data }) => Object.assign(db.users.get(where.id), data),
  },
  $transaction: async (ops) => Promise.all(ops),
};

const stub = (relPath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub("../utils/db", { prisma });
stub("../utils/deleteUserData", async () => {});
stub("../utils/sendEmailNotification", async () => {});

const { faceRegister, faceLogin, faceRemove } = require("./authControllers");
const { FACE_MODEL } = require("../utils/faceEncodingStore");

// ── Fake hosted face service: returns whatever encoding the test queues ──
const faceCalls = [];
let nextFaceReply = null;
global.fetch = async (url, options) => {
  faceCalls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
  const { status = 200, data } = nextFaceReply;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(data),
  };
};
const encoded = (vector) => ({ data: { success: true, model: FACE_MODEL, encoding: vector } });

// Deterministic 128-d vectors (seeded PRNG): one per person, far apart,
// plus small capture noise for "the same person again".
const face = (seed) => {
  let state = (seed * 2654435761) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 128 }, () => (random() - 0.5) * 0.3);
};
const jitter = (vector, amount = 0.01) => vector.map((v, i) => v + Math.cos(i * 3.1) * amount);

const frames = Array.from({ length: 16 }, () => "data:image/jpeg;base64,AAAA");
const addAccount = (n) => {
  const user = { id: `user${n}`, _id: `user${n}`, firstName: `First${n}`, surname: "S", profile: `profile${n}`, faceLoginEnabled: false };
  const profile = { id: `profile${n}`, _id: `profile${n}`, username: `person${n}`, user: user.id };
  db.users.set(user.id, user);
  db.profiles.set(profile.id, profile);
  return { req: { body: { frames }, profile: { ...profile, user: { _id: user.id } } }, user, profile };
};

const call = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });

const alice = addAccount(1);
const bob = addAccount(2);

test("register stores a tagged encoding in MySQL and turns face login on", async () => {
  nextFaceReply = encoded(face(1));
  const { status, body } = await call(faceRegister, alice.req);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(faceCalls.at(-1).url, "https://face.example.test/face-api/api/face/encode");
  assert.equal(faceCalls.at(-1).headers["X-Face-Service-Key"], "server-key");
  // Only the frames and what they are for leave this server: no username.
  assert.deepEqual(Object.keys(faceCalls.at(-1).body), ["frames", "purpose"]);
  assert.equal(faceCalls.at(-1).body.purpose, "register");
  const rows = db.faceencodings.filter((row) => row.profile === "profile1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].faceEncoding.model, FACE_MODEL);
  assert.equal(rows[0].faceEncoding.vector.length, 128);
  assert.equal(alice.user.faceLoginEnabled, true);

  // Registering again replaces the row instead of adding one.
  nextFaceReply = encoded(jitter(face(1)));
  assert.equal((await call(faceRegister, alice.req)).status, 200);
  assert.equal(db.faceencodings.filter((row) => row.profile === "profile1").length, 1);
});

test("a face already registered to another account is refused", async () => {
  nextFaceReply = encoded(jitter(face(1), 0.02));
  const { status, body } = await call(faceRegister, bob.req);
  assert.equal(status, 409);
  assert.equal(body.code, "face_already_registered");
  assert.equal(db.faceencodings.some((row) => row.profile === "profile2"), false);
});

test("login matches the closest stored face and signs that account in", async () => {
  nextFaceReply = encoded(face(2));
  assert.equal((await call(faceRegister, bob.req)).status, 200);

  nextFaceReply = encoded(jitter(face(2), 0.015));
  const { status, body } = await call(faceLogin, { body: { frames } });
  assert.equal(status, 202, JSON.stringify(body));
  assert.equal(body.user_id, "user2");
  assert.ok(body.accessToken);

  nextFaceReply = encoded(face(7));
  assert.equal((await call(faceLogin, { body: { frames } })).status, 401);
});

test("old face-api.js rows are never matched", async () => {
  db.faceencodings.push({ id: "legacy", name: "old", profile: "profile3", faceEncoding: face(9) });
  db.profiles.set("profile3", { id: "profile3", user: "user1" });
  nextFaceReply = encoded(face(9));
  assert.equal((await call(faceLogin, { body: { frames } })).status, 401);
});

test("a failed liveness check is not a session error and stores nothing", async () => {
  const before = db.faceencodings.length;
  nextFaceReply = { status: 422, data: { success: false, code: "liveness_failed", message: "liveness check failed" } };
  const register = await call(faceRegister, alice.req);
  assert.equal(register.status, 400);
  assert.match(register.body.message, /liveness/);
  // The client retries a missed blink automatically when it sees this code.
  assert.equal(register.body.code, "liveness_failed");
  const login = await call(faceLogin, { body: { frames } });
  assert.equal(login.status, 401);
  assert.equal(login.body.code, "liveness_failed");
  assert.equal(faceCalls.at(-1).body.purpose, "login");
  assert.equal(db.faceencodings.length, before);
});

test("remove deletes the account's face data and turns face login off", async () => {
  const { status } = await call(faceRemove, alice.req);
  assert.equal(status, 200);
  assert.equal(db.faceencodings.some((row) => row.profile === "profile1"), false);
  assert.equal(alice.user.faceLoginEnabled, false);

  nextFaceReply = encoded(face(1));
  assert.equal((await call(faceLogin, { body: { frames } })).status, 401);
});

test("login refuses an account that turned face login off", async () => {
  bob.user.faceLoginEnabled = false;
  nextFaceReply = encoded(face(2));
  assert.equal((await call(faceLogin, { body: { frames } })).status, 404);
});
