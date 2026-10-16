// Two API servers (separate processes, like production behind the load
// balancer). The host plays on one server and the guest on the other; the game
// runs on its owner server and both see the same board until the end.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { io: ioClient } = require("socket.io-client");

const HOST = "d".repeat(24);
const GUEST = "e".repeat(24);
const PORT_A = 4961 + Math.floor(Math.random() * 20) * 2;
const PORT_B = PORT_A + 1;
const URL_A = `http://127.0.0.1:${PORT_A}`;
const URL_B = `http://127.0.0.1:${PORT_B}`;

const startServer = (port, self) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "fixtures/peerServer.js")], {
      env: {
        ...process.env,
        PORT: String(port),
        INSTANCE_URL: self,
        PEER_SERVERS: `${URL_A},${URL_B}`,
        LB_INTERNAL_SECRET: "cluster-test",
        LUDO_PATH_LENGTH: "8",
        LUDO_TIMINGS: JSON.stringify({
          stepMs: 3,
          moveSettleMs: 10,
          captureMs: 5,
          winMs: 5,
          passMs: 15,
          autoMoveMs: 15,
          botRollMs: 5,
          botMoveMs: 5,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("READY")) resolve(child);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${output}`)));
    setTimeout(() => reject(new Error(`server did not start: ${output}`)), 20000);
  });

const connect = (url, profile) =>
  new Promise((resolve) => {
    const socket = ioClient(url, { query: { profile }, transports: ["websocket"], forceNew: true });
    socket.latest = null;
    socket.on("ludo:state", (state) => {
      if (!socket.latest || state.version > socket.latest.version) socket.latest = state;
    });
    socket.on("connect", () => resolve(socket));
  });

const ask = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, (result) => resolve(result)));

const waitFor = async (predicate, label, timeout = 20000) => {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("a game spans two servers: invite, accept, pause/resume, play to the end", { timeout: 120000 }, async () => {
  const servers = await Promise.all([startServer(PORT_A, URL_A), startServer(PORT_B, URL_B)]);
  const host = await connect(URL_A, HOST);
  const guest = await connect(URL_B, GUEST);
  const invites = [];
  guest.on("ludo:invite", (invite) => invites.push(invite));
  try {
    const created = await ask(host, "ludo:create", {
      playerCount: 2,
      seats: [{ kind: "invite", profileId: GUEST, name: "Guest" }],
      host: { name: "Host" },
    });
    assert.equal(created.ok, true);
    const { gameId } = created;

    // The invite crosses servers, live and through the invite list.
    await waitFor(() => invites.find((i) => i.gameId === gameId), "live invite on the other server");
    const listed = await ask(guest, "ludo:invites:get", {});
    assert.deepEqual(listed.invites.map((i) => i.gameId), [gameId]);

    const accepted = await ask(guest, "ludo:accept", { gameId, connect: { fullName: "Guest" } });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.seat, 1);
    await waitFor(() => host.latest?.status === "playing" && guest.latest?.status === "playing", "both see the match start");

    // Pause from the guest's server, seen on the host's; resume from the host.
    await ask(guest, "ludo:pause", { gameId });
    await waitFor(() => host.latest?.paused, "host sees pause");
    const blocked = await ask(host, "ludo:roll", { gameId });
    assert.equal(blocked.error, "paused");
    await ask(host, "ludo:resume", { gameId });
    await waitFor(() => guest.latest && !guest.latest.paused, "guest sees resume");

    // Both play until the end.
    const play = async (socket, profileId) => {
      for (;;) {
        const s = socket.latest;
        if (s?.gameEnded) return s;
        const seat = s?.players?.[s.currentPlayer];
        if (s && seat?.profileId === profileId) {
          if (s.phase === "roll") await ask(socket, "ludo:roll", { gameId });
          else if (s.phase === "move" && s.movable.length) {
            await ask(socket, "ludo:move", { gameId, pieceIndex: s.movable[0] });
          }
        }
        socket.emit("ludo:ping", { gameId }, () => {});
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    };
    const [hostEnd, guestEnd] = await Promise.all([play(host, HOST), play(guest, GUEST)]);
    assert.equal(hostEnd.gameId, gameId);
    assert.equal(guestEnd.status, "ended");
    assert.equal(hostEnd.winners[0].seat, guestEnd.winners[0].seat);
  } finally {
    host.close();
    guest.close();
    servers.forEach((child) => child.kill());
  }
});
