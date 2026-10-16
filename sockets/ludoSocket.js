// Ludo over Socket.IO. Games are hosted by the server (see ./ludo/host.js):
// clients send intents and receive the authoritative `ludo:state`.
//
// Client -> server (every event takes an optional ack callback):
//   ludo:create        { playerCount, seats: [{ kind: bot|local|invite|open, profileId?, name?, avatar? }], host? }
//   ludo:join          { gameId }                 open the board (members) / view a lobby
//   ludo:accept        { gameId, slotIndex? }     take a seat (invite or open seat)
//   ludo:invites:dismiss { gameId }               decline an invite
//   ludo:invite        { gameId, to, slotIndex? } host: invite a connect / re-invite a player
//   ludo:reinvite      { gameId }                 host: re-invite everyone who is away
//   ludo:start         { gameId }                 host: fill empty seats with computers and start
//   ludo:roll          { gameId }
//   ludo:move          { gameId, pieceIndex }
//   ludo:pause / ludo:resume { gameId }
//   ludo:replace:bot   { gameId, playerIndex }    host
//   ludo:seat:update   { gameId, playerIndex, name?, avatar? }  host (computer/local seats)
//   ludo:leave         { gameId }                 host ends the game; others hand their seat to the computer
//   ludo:board:closed  { gameId }                 left the board but kept the seat (saved for later)
//   ludo:state:get     { gameId }                 (alias: ludo:players:get)
//   ludo:ping          { gameId? }                health probe + presence heartbeat
//   ludo:games:get / ludo:invites:get
// Server -> client: ludo:state, ludo:games, ludo:invites, ludo:invite,
//   ludo:game:removed, ludo:seat:replaced, ludo:error

const { createLudoHost } = require("./ludo/host");
const store = require("./ludo/store");
const { createCluster } = require("./ludo/cluster");

let debugLogger = null;
try {
  ({ debugLogger } = require("../utils/debugLogger"));
} catch (_e) {}

const LOUD_EVENTS = new Set(["action-error", "timer-error", "save-failed", "restore-failed"]);

const log = (event, data) => {
  if (LOUD_EVENTS.has(event)) {
    console.error(`[ludo] ${event}`, data);
    return;
  }
  try {
    debugLogger?.ludoEvent?.(event, data);
  } catch (_e) {}
};

const runtimes = new WeakMap(); // io -> { host, cluster }

const str = (value) => (value == null ? "" : String(value));
const room = (gameId) => `ludo_${gameId}`;
const userRoom = (profileId) => `user_${profileId}`;

const runtimeFor = (io) => {
  let runtime = runtimes.get(io);
  if (runtime) return runtime;
  const inviteTimers = new Map();
  const hooks = {
    // The invite list a player sees spans games owned by every server.
    onInvitesChanged: (profileId) => {
      const pid = str(profileId);
      if (!pid || inviteTimers.has(pid)) return;
      inviteTimers.set(
        pid,
        setTimeout(async () => {
          inviteTimers.delete(pid);
          const invites = await collectInvites(runtime, pid);
          try {
            io.to(userRoom(pid)).emit("ludo:invites", { invites });
          } catch (_e) {}
        }, 60),
      );
    },
  };
  let timings;
  try {
    // Tests speed the game up (e.g. LUDO_TIMINGS='{"stepMs":5}').
    timings = process.env.LUDO_TIMINGS ? JSON.parse(process.env.LUDO_TIMINGS) : undefined;
  } catch (_e) {
    timings = undefined;
  }
  const host = createLudoHost({ io, store, hooks, log, timings });
  const cluster = createCluster(host);
  runtime = { io, host, cluster };
  runtimes.set(io, runtime);
  return runtime;
};

const collectInvites = async (runtime, profileId) => {
  const answers = await runtime.cluster.callAll("invites", profileId);
  const byGame = new Map();
  answers.forEach((answer) => {
    (answer?.invites || []).forEach((invite) => {
      const previous = byGame.get(invite.gameId);
      if (!previous || Number(invite.ts) > Number(previous.ts)) byGame.set(invite.gameId, invite);
    });
  });
  return [...byGame.values()].sort((a, b) => Number(b.ts) - Number(a.ts));
};

const collectGames = async (runtime, profileId) => {
  const [answers, saved] = await Promise.all([
    runtime.cluster.callAll("games", profileId),
    runtime.host.savedSummaries(profileId),
  ]);
  const byGame = new Map();
  answers.forEach((answer) => (answer?.games || []).forEach((game) => byGame.set(game.gameId, game)));
  saved.forEach((game) => {
    if (!byGame.has(game.gameId)) byGame.set(game.gameId, { ...game, saved: true });
  });
  return [...byGame.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
};

function ludoSocket(io, socket, profileId) {
  const runtime = runtimeFor(io);
  const pid = (() => {
    const raw = str(profileId || socket?.handshake?.query?.profile || socket?.handshake?.query?.profileId);
    return raw && raw !== "null" && raw !== "undefined" ? raw : "";
  })();
  const joined = new Set(); // game rooms this socket is in
  const ctx = { socketId: socket.id };

  if (pid) {
    try {
      socket.join(userRoom(pid));
    } catch (_e) {}
  }

  const reply = (ack, result) => {
    if (typeof ack === "function") {
      try {
        ack(result);
      } catch (_e) {}
    }
  };

  const reportError = (result, gameId) => {
    if (result && !result.ok) {
      socket.emit("ludo:error", {
        gameId: gameId || result.gameId || null,
        error: result.error,
        message: result.message,
      });
    }
  };

  const enterRoom = (gameId) => {
    socket.join(room(gameId));
    joined.add(gameId);
  };
  const exitRoom = (gameId) => {
    socket.leave(room(gameId));
    joined.delete(gameId);
  };

  const call = (action, gameId, payload) =>
    runtime.cluster.call(gameId, action, pid, { ...(payload || {}), gameId }, ctx);

  const needsAuth = (ack) => {
    if (pid) return false;
    reply(ack, { ok: false, error: "auth", message: "Sign in to play." });
    return true;
  };

  // Opening a board: join the room first so no broadcast is missed, then ask
  // the game host; a game that doesn't exist releases the room again.
  const openBoard = (action) => async (payload = {}, ack) => {
    const gameId = str(payload?.gameId);
    if (!gameId) return reply(ack, { ok: false, error: "bad_request" });
    if (needsAuth(ack)) return undefined;
    enterRoom(gameId);
    const result = await call(action, gameId, payload);
    if (!result?.ok) {
      if (result?.error === "not_found") {
        exitRoom(gameId);
        socket.emit("ludo:game:removed", { gameId, reason: "not_found", serverTs: Date.now() });
      }
      reportError(result, gameId);
    } else if (result.state) {
      socket.emit("ludo:state", result.state);
    }
    return reply(ack, result);
  };

  const simple = (action, { requireGame = true } = {}) => async (payload = {}, ack) => {
    const gameId = str(payload?.gameId);
    if (requireGame && !gameId) return reply(ack, { ok: false, error: "bad_request" });
    if (needsAuth(ack)) return undefined;
    const result = await call(action, gameId, payload);
    if (!result?.ok) reportError(result, gameId);
    return reply(ack, result);
  };

  socket.on("ludo:create", async (payload = {}, ack) => {
    if (needsAuth(ack)) return;
    const gameId = runtime.cluster.newLocalGameId();
    enterRoom(gameId);
    const result = await call("create", gameId, payload);
    if (!result?.ok) {
      exitRoom(gameId);
      reportError(result, gameId);
    } else if (result.state) {
      socket.emit("ludo:state", result.state);
    }
    reply(ack, result);
  });

  socket.on("ludo:join", openBoard("join"));
  socket.on("ludo:accept", openBoard("accept"));
  socket.on("ludo:state:get", openBoard("state"));
  socket.on("ludo:players:get", openBoard("state"));

  socket.on("ludo:invites:dismiss", simple("decline"));
  socket.on("ludo:decline", simple("decline"));
  socket.on("ludo:invite", simple("invite"));
  socket.on("ludo:reinvite", simple("reinvite"));
  socket.on("ludo:start", simple("start"));
  socket.on("ludo:roll", simple("roll"));
  socket.on("ludo:move", simple("move"));
  socket.on("ludo:pause", simple("pause"));
  socket.on("ludo:resume", simple("resume"));
  socket.on("ludo:replace:bot", simple("replaceBot"));
  socket.on("ludo:seat:update", simple("updateSeat"));

  socket.on("ludo:leave", async (payload = {}, ack) => {
    const gameId = str(payload?.gameId);
    if (!gameId) return reply(ack, { ok: false, error: "bad_request" });
    if (needsAuth(ack)) return undefined;
    const result = await call("leave", gameId, payload);
    exitRoom(gameId);
    return reply(ack, result);
  });

  socket.on("ludo:board:closed", async (payload = {}, ack) => {
    const gameId = str(payload?.gameId);
    if (!gameId) return reply(ack, { ok: false });
    exitRoom(gameId);
    const result = pid ? await call("away", gameId, payload) : { ok: true };
    return reply(ack, result);
  });

  // Health probe for the client's "reconnecting" overlay; with a gameId it is
  // also the presence heartbeat that keeps the player's seat online.
  socket.on("ludo:ping", (payload, ack) => {
    if (typeof payload === "function") {
      payload({ serverTs: Date.now() });
      return;
    }
    reply(ack, { serverTs: Date.now() });
    const gameId = str(payload?.gameId);
    if (pid && gameId) {
      if (!joined.has(gameId)) enterRoom(gameId);
      call("presence", gameId, {}).catch(() => {});
    }
  });

  socket.on("ludo:games:get", async (_payload, ack) => {
    if (!pid) return reply(typeof _payload === "function" ? _payload : ack, { ok: false, games: [] });
    const games = await collectGames(runtime, pid);
    socket.emit("ludo:games", { games });
    return reply(typeof _payload === "function" ? _payload : ack, { ok: true, games });
  });

  socket.on("ludo:invites:get", async (_payload, ack) => {
    if (!pid) return reply(typeof _payload === "function" ? _payload : ack, { ok: false, invites: [] });
    const invites = await collectInvites(runtime, pid);
    socket.emit("ludo:invites", { invites });
    return reply(typeof _payload === "function" ? _payload : ack, { ok: true, invites });
  });

  socket.on("disconnect", () => {
    if (!pid) return;
    joined.forEach((gameId) => {
      runtime.cluster.call(gameId, "away", pid, { gameId }, ctx).catch(() => {});
    });
    joined.clear();
  });

  // Pending invites as soon as the player connects.
  if (pid) {
    collectInvites(runtime, pid)
      .then((invites) => {
        if (invites.length) socket.emit("ludo:invites", { invites });
      })
      .catch(() => {});
  }
}

/** For REST handlers: runs a game action through the game's owner server. */
ludoSocket.dispatch = (action, gameId, profileId, payload = {}) => {
  const io = global.io;
  if (!io) return Promise.resolve({ ok: false, error: "unavailable" });
  const runtime = runtimeFor(io);
  return runtime.cluster.call(str(gameId), action, str(profileId), { ...payload, gameId: str(gameId) }, {});
};

/** Internal route other API servers use to reach the games this one owns. */
ludoSocket.attachRelayRoute = (app, io) => runtimeFor(io).cluster.attachRoute(app);

/** Test helper: the host behind an io instance. */
ludoSocket.hostFor = (io) => runtimeFor(io).host;

module.exports = ludoSocket;
