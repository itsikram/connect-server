const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

process.env.JWT_SECRET_KEY = "expression-bridge-test-secret";
process.env.FACE_SERVICE_API_KEY = "server-only-key";
process.env.FACE_ANALYZE_URL = "https://face.example.test/face-api/";
delete process.env.FACE_EXPRESSION_BRIDGE;

const {
  attachExpressionBridge,
  checkFaceApi,
  getFaceApiUrl,
  isBridgeEnabled,
  issueExpressionToken,
  publicOriginOf,
  verifyExpressionToken,
} = require("./expressionBridge");

const quietLog = { warn: () => {}, info: () => {} };

/** Fake face service: records calls, answers with `reply(body)` -> { status, data, delayMs }. */
const fakeFaceApi = (reply) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, headers: options.headers, body });
    const { status = 200, data = {}, delayMs = 0 } = (await reply(body)) || {};
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { status, ok: status >= 200 && status < 300, json: async () => data };
  };
  return { calls, fetchImpl };
};

const startServer = async (fetchImpl) => {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  attachExpressionBridge(io, { fetchImpl, log: quietLog });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  return {
    url,
    close: () => new Promise((resolve) => { io.close(); httpServer.close(() => resolve()); }),
  };
};

const connect = (url, token) =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${url}/expressions`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => { socket.close(); reject(error); });
  });

const nextEvent = (socket, names) =>
  new Promise((resolve) => {
    const handlers = names.map((name) => {
      const handler = (data) => {
        names.forEach((other, index) => socket.off(other, handlers[index]));
        resolve({ name, data });
      };
      socket.on(name, handler);
      return handler;
    });
  });

test("tokens are scoped to the expression socket", () => {
  const token = issueExpressionToken("profile-1");
  assert.equal(verifyExpressionToken(token).sub, "profile-1");
  // A login token (signed with the login secret) is not an expression token...
  const loginToken = jwt.sign({ user_id: "u1" }, process.env.JWT_SECRET_KEY);
  assert.equal(verifyExpressionToken(loginToken), null);
  // ...and an expression token does not verify as a login token.
  assert.throws(() => jwt.verify(token, process.env.JWT_SECRET_KEY));
  assert.equal(verifyExpressionToken("garbage"), null);
  assert.equal(verifyExpressionToken(""), null);
});

test("configuration defaults and the public origin", () => {
  assert.equal(isBridgeEnabled(), true);
  assert.equal(getFaceApiUrl(), "https://face.example.test/face-api");
  const req = {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "api.example.test" },
    protocol: "http",
    get: () => "internal:4000",
  };
  assert.equal(publicOriginOf(req), "https://api.example.test");
  assert.equal(
    publicOriginOf({ headers: {}, protocol: "http", get: () => "localhost:4000" }),
    "http://localhost:4000",
  );
});

test("sockets without a valid expression token are refused", async () => {
  const { fetchImpl } = fakeFaceApi(() => ({}));
  const server = await startServer(fetchImpl);
  try {
    for (const token of [undefined, "", "not-a-jwt", jwt.sign({ user_id: "u1" }, process.env.JWT_SECRET_KEY)]) {
      await assert.rejects(connect(server.url, token), /unauthorized/);
    }
  } finally {
    await server.close();
  }
});

test("a frame is forwarded with the server key and the result comes back", async () => {
  const { calls, fetchImpl } = fakeFaceApi(() => ({
    data: { label: "happy", confidence: 0.91, base_emotion: "happy", timestamp: 1, connect_relayed: true },
  }));
  const server = await startServer(fetchImpl);
  const socket = await connect(server.url, issueExpressionToken("profile-1"));
  try {
    const reply = nextEvent(socket, ["expression_update", "expression_error"]);
    socket.emit("frame", { image: "data:image/jpeg;base64,AAAA", profileId: "p", connectId: "c" });
    const { name, data } = await reply;
    assert.equal(name, "expression_update");
    assert.equal(data.label, "happy");
    // Clients must send emotion_change themselves on their signed-in socket.
    assert.equal(data.connect_relayed, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://face.example.test/face-api/api/expression/analyze");
    assert.equal(calls[0].headers["X-Face-Service-Key"], "server-only-key");
    assert.deepEqual(calls[0].body, { sessionId: socket.id, image: "data:image/jpeg;base64,AAAA" });
  } finally {
    socket.close();
    await server.close();
  }
});

test("one frame in flight per socket; extra frames are skipped, not queued", async () => {
  const { calls, fetchImpl } = fakeFaceApi(() => ({ data: { label: "neutral" }, delayMs: 150 }));
  const server = await startServer(fetchImpl);
  const socket = await connect(server.url, issueExpressionToken("profile-1"));
  try {
    const skipped = nextEvent(socket, ["expression_skipped"]);
    const update = nextEvent(socket, ["expression_update"]);
    socket.emit("frame", { image: "AAAA" });
    socket.emit("frame", { image: "BBBB" });
    assert.equal((await skipped).data.reason, "busy");
    assert.equal((await update).data.label, "neutral");
    assert.equal(calls.length, 1);
  } finally {
    socket.close();
    await server.close();
  }
});

test("bad frames and face service failures become expression_error", async () => {
  let status = 401;
  const { fetchImpl } = fakeFaceApi(() => ({ status, data: { message: "face service authorization required" } }));
  const server = await startServer(fetchImpl);
  const socket = await connect(server.url, issueExpressionToken("profile-1"));
  try {
    let reply = nextEvent(socket, ["expression_error"]);
    socket.emit("frame", { image: 42 });
    assert.match((await reply).data.message, /base64/);

    await new Promise((resolve) => setTimeout(resolve, 100));
    reply = nextEvent(socket, ["expression_error"]);
    socket.emit("frame", { image: "AAAA" });
    assert.equal((await reply).data.message, "face service authorization required");

    status = 429;
    await new Promise((resolve) => setTimeout(resolve, 100));
    reply = nextEvent(socket, ["expression_skipped", "expression_error"]);
    socket.emit("frame", { image: "AAAA" });
    assert.equal((await reply).name, "expression_skipped");
  } finally {
    socket.close();
    await server.close();
  }
});

test("an unreachable face service is reported, and disconnect frees the session", async () => {
  let fail = true;
  const { calls, fetchImpl } = fakeFaceApi(() => {
    if (fail) throw new Error("connect ECONNREFUSED");
    return { data: { label: "neutral" } };
  });
  const server = await startServer(fetchImpl);
  const socket = await connect(server.url, issueExpressionToken("profile-1"));
  try {
    let reply = nextEvent(socket, ["expression_error"]);
    socket.emit("frame", { image: "AAAA" });
    assert.equal((await reply).data.message, "face service unavailable");

    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    reply = nextEvent(socket, ["expression_update"]);
    socket.emit("frame", { image: "AAAA" });
    await reply;
    const sessionId = socket.id;
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(calls.at(-1).body, { sessionId, end: true });
  } finally {
    await server.close();
  }
});

test("a dropped keep-alive connection is retried once; a timeout is not", async () => {
  let failures = 1;
  const flaky = fakeFaceApi(() => {
    if (failures-- > 0) throw new TypeError("fetch failed: other side closed");
    return { data: { ok: true } };
  });
  assert.equal((await checkFaceApi(flaky.fetchImpl)).authorized, true);
  assert.equal(flaky.calls.length, 2);

  const timeout = fakeFaceApi(() => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  });
  assert.equal((await checkFaceApi(timeout.fetchImpl)).reachable, false);
  assert.equal(timeout.calls.length, 1);
});

test("status check reports reachability and whether the key is accepted", async () => {
  const ok = fakeFaceApi(() => ({ status: 200, data: { ok: true } }));
  assert.deepEqual(
    (({ reachable, authorized }) => ({ reachable, authorized }))(await checkFaceApi(ok.fetchImpl)),
    { reachable: true, authorized: true },
  );
  assert.deepEqual(ok.calls[0].body, { sessionId: "status-check", end: true });
  const wrongKey = fakeFaceApi(() => ({ status: 401 }));
  assert.equal((await checkFaceApi(wrongKey.fetchImpl)).authorized, false);
  const down = fakeFaceApi(() => { throw new Error("down"); });
  assert.equal((await checkFaceApi(down.fetchImpl)).reachable, false);
});

test("FACE_EXPRESSION_BRIDGE=0 turns the namespace off", async () => {
  process.env.FACE_EXPRESSION_BRIDGE = "0";
  const { fetchImpl } = fakeFaceApi(() => ({}));
  const server = await startServer(fetchImpl);
  try {
    assert.equal(isBridgeEnabled(), false);
    await assert.rejects(connect(server.url, issueExpressionToken("p")), /disabled/);
  } finally {
    delete process.env.FACE_EXPRESSION_BRIDGE;
    await server.close();
  }
});
