const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const { createSocketAuth, profileIdOf } = require("./socketAuth");

const SECRET = "socket-auth-test-secret";
const ALICE_USER = "u".repeat(24);
const ALICE = "a".repeat(24);
const MALLORY = "m".repeat(24);

const tokenFor = (userId, options = {}) => jwt.sign({ user_id: userId }, SECRET, { expiresIn: "1h", ...options });

const makeAuth = (mode, overrides = {}) =>
  createSocketAuth({
    verifyToken: (token) => jwt.verify(token, SECRET).user_id,
    loadProfileId: async (userId) => (userId === ALICE_USER ? ALICE : null),
    mode: () => mode,
    log: () => {},
    ...overrides,
  });

const fakeSocket = (handshake) => ({ handshake: { query: {}, auth: {}, headers: {}, ...handshake } });

const run = (auth, socket) =>
  new Promise((resolve) => auth.middleware(socket, (error) => resolve({ error, data: socket.data })));

test("a valid token decides the identity; a claimed profile can't override it", async () => {
  const socket = fakeSocket({ query: { profile: MALLORY }, auth: { token: tokenFor(ALICE_USER) } });
  const { error, data } = await run(makeAuth("strict"), socket);
  assert.equal(error, undefined);
  assert.equal(data.profileId, ALICE);
  assert.equal(data.authenticated, true);
  assert.equal(profileIdOf(socket), ALICE);
});

test("strict mode refuses a claimed profile without a valid token", async () => {
  for (const handshake of [
    { query: { profile: ALICE } },
    { query: { profile: ALICE }, auth: { token: "not-a-jwt" } },
    { query: { profile: ALICE }, auth: { token: tokenFor(ALICE_USER, { expiresIn: -10 }) } },
    { query: { profile: ALICE }, auth: { token: jwt.sign({ user_id: ALICE_USER }, "wrong-secret") } },
  ]) {
    const { error } = await run(makeAuth("strict"), fakeSocket(handshake));
    assert.ok(error, JSON.stringify(handshake));
    assert.equal(error.data.code, "unauthorized");
  }
  const expired = await run(
    makeAuth("strict"),
    fakeSocket({ query: { profile: ALICE }, auth: { token: tokenFor(ALICE_USER, { expiresIn: -10 }) } }),
  );
  assert.equal(expired.error.data.reason, "expired");
});

test("grace mode keeps old clients (no token) working on their claimed profile", async () => {
  const { error, data } = await run(makeAuth("grace"), fakeSocket({ query: { profile: ALICE } }));
  assert.equal(error, undefined);
  assert.equal(data.profileId, ALICE);
  assert.equal(data.authenticated, false);
});

test("no claimed profile and no token: anonymous in every mode", async () => {
  for (const mode of ["grace", "strict"]) {
    const { error, data } = await run(makeAuth(mode), fakeSocket({ query: { profile: "null" } }));
    assert.equal(error, undefined);
    assert.equal(data.profileId, null);
  }
});

test("database down: strict refuses with a retryable code", async () => {
  const auth = makeAuth("strict", {
    loadProfileId: async () => {
      const error = new Error("down");
      error.code = "unavailable";
      throw error;
    },
  });
  const { error } = await run(auth, fakeSocket({ query: { profile: ALICE }, auth: { token: tokenFor(ALICE_USER) } }));
  assert.equal(error.data.code, "unavailable");
});

test("over a real handshake: the auth callback's token wins over a spoofed query", async () => {
  const server = http.createServer();
  const io = new Server(server);
  io.use(makeAuth("strict").middleware);
  io.on("connection", (socket) => socket.emit("whoami", socket.data.profileId));
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const connect = (options) =>
    new Promise((resolve) => {
      const client = ioClient(url, { transports: ["websocket"], forceNew: true, reconnection: false, ...options });
      client.on("whoami", (id) => resolve({ client, id }));
      client.on("connect_error", (error) => resolve({ client, error }));
    });
  try {
    const spoofed = await connect({
      query: { profile: MALLORY },
      auth: (cb) => cb({ profile: MALLORY, token: tokenFor(ALICE_USER) }),
    });
    assert.equal(spoofed.id, ALICE);
    spoofed.client.close();

    const noToken = await connect({ query: { profile: MALLORY } });
    assert.equal(noToken.error?.message, "unauthorized");
    assert.equal(noToken.error?.data?.code, "unauthorized");
    noToken.client.close();
  } finally {
    io.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
