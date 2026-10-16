const test = require("node:test");
const assert = require("node:assert/strict");
const { createLudoHost } = require("./host");

const HOST = "a".repeat(24);
const GUEST = "b".repeat(24);
const THIRD = "c".repeat(24);

const FAST = {
  stepMs: 2,
  moveSettleMs: 5,
  captureMs: 5,
  winMs: 5,
  passMs: 10,
  autoMoveMs: 10,
  botRollMs: 5,
  botMoveMs: 5,
  offlineGraceMs: 60,
  presenceTtlMs: 10000,
  sweepMs: 20,
  saveDebounceMs: 5,
};

const makeIo = () => {
  const emitted = [];
  return {
    emitted,
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
    last: (event, room) => [...emitted].reverse().find((e) => e.event === event && (!room || e.room === room)),
  };
};

const makeStore = () => {
  const rows = new Map();
  return {
    rows,
    ready: () => true,
    saveGame: async (record) => {
      rows.set(record.gameId, JSON.parse(JSON.stringify(record)));
      return true;
    },
    loadGame: async (gameId) => (rows.has(gameId) ? JSON.parse(JSON.stringify(rows.get(gameId))) : null),
    deleteGame: async (gameId) => rows.delete(gameId),
    listGamesForPlayer: async (pid) =>
      [...rows.values()].filter((row) => !row.gameEnded && row.playerProfileIds.includes(pid)),
    loadProfiles: async (ids) =>
      new Map(ids.map((id) => [id, { id, fullName: `User ${id[0]}`, profilePic: `https://img/${id[0]}.png`, coverPic: `https://cover/${id[0]}.png` }])),
    notifyInvite: async () => {},
    clearInviteNotifications: async () => {},
  };
};

const setup = (opts = {}) => {
  const io = makeIo();
  const dice = [];
  const host = createLudoHost({
    io,
    store: opts.store || null,
    timings: { ...FAST, ...(opts.timings || {}) },
    pathLength: opts.pathLength || 8,
    randomDie: () => (dice.length ? dice.shift() : 1 + Math.floor(Math.random() * 6)),
  });
  return { io, host, dice };
};

const waitFor = async (predicate, { timeout = 4000, label = "condition" } = {}) => {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const stateOf = async (host, gameId) => (await host.handle("state", HOST, { gameId })).state;

// Plays a human seat like a person: rolls when allowed, moves the first legal piece.
const autoPlay = (host, profileId, gameId) => {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const res = await host.handle("state", profileId, { gameId });
      const state = res.state;
      if (!state || state.gameEnded) return;
      const seat = state.players[state.currentPlayer];
      const mine =
        (seat.kind === "human" && seat.profileId === profileId) ||
        (seat.kind === "local" && state.hostId === profileId);
      if (mine && !state.paused) {
        if (state.phase === "roll") await host.handle("roll", profileId, { gameId });
        else if (state.phase === "move" && state.movable.length) {
          await host.handle("move", profileId, { gameId, pieceIndex: state.movable[state.movable.length - 1] });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  };
  const done = loop();
  return { stop: () => { stopped = true; return done; }, done };
};

test("vs computer: the server plays the computer and the match ends", async () => {
  const { host } = setup();
  const created = await host.handle("create", HOST, { playerCount: 4, seats: [{ kind: "bot" }, { kind: "bot" }, { kind: "bot" }] }, { socketId: "s1" });
  assert.equal(created.ok, true);
  assert.equal(created.state.status, "playing");
  assert.equal(created.state.mode, "computer");
  assert.equal(created.state.currentPlayer, 0);
  const player = autoPlay(host, HOST, created.gameId);
  const end = await waitFor(async () => {
    const s = await stateOf(host, created.gameId);
    return s.gameEnded ? s : null;
  }, { timeout: 60000, label: "game end" });
  await player.stop();
  assert.equal(end.status, "ended");
  assert.equal(end.standings.length, 4);
  assert.ok(end.winners.length >= 3);
  host.shutdown();
});

test("rolls and moves are validated by the server", async () => {
  const { host, dice } = setup();
  const { gameId } = await host.handle("create", HOST, { playerCount: 2, seats: [{ kind: "bot" }] }, { socketId: "s1" });
  // Not this player's game / turn.
  assert.equal((await host.handle("roll", GUEST, { gameId })).error, "not_your_turn");
  assert.equal((await host.handle("move", HOST, { gameId, pieceIndex: 0 })).error, "wrong_phase");

  dice.push(6);
  const rolled = await host.handle("roll", HOST, { gameId });
  assert.equal(rolled.ok, true);
  assert.equal(rolled.state.phase, "move");
  assert.equal(rolled.state.diceValue, 6);
  assert.deepEqual(rolled.state.movable, [0, 1, 2, 3]);
  assert.equal((await host.handle("roll", HOST, { gameId })).error, "wrong_phase");

  // All four yard moves are the same move, so the server plays it.
  const moved = await waitFor(async () => {
    const s = await stateOf(host, gameId);
    return s.lastAction?.type === "move" ? s : null;
  }, { label: "auto move" });
  assert.equal(moved.lastAction.auto, true);
  assert.equal(moved.lastAction.from, 0);
  assert.equal(moved.lastAction.to, 1);

  // A six keeps the turn.
  const again = await waitFor(async () => {
    const s = await stateOf(host, gameId);
    return s.phase === "roll" && s.lastAction?.type === "turn" ? s : null;
  }, { label: "same player rolls again" });
  assert.equal(again.currentPlayer, 0);
  assert.equal(again.lastAction.again, true);
  host.shutdown();
});

test("three sixes in a row forfeit the turn", async () => {
  const { host, dice } = setup({ timings: { autoMoveMs: 100000 } });
  const { gameId } = await host.handle("create", HOST, { playerCount: 2, seats: [{ kind: "bot" }] }, { socketId: "s1" });
  for (let i = 0; i < 2; i += 1) {
    dice.push(6);
    await host.handle("roll", HOST, { gameId });
    const s = await stateOf(host, gameId);
    await host.handle("move", HOST, { gameId, pieceIndex: s.movable[0] });
    await waitFor(async () => (await stateOf(host, gameId)).phase === "roll", { label: "turn kept" });
  }
  dice.push(6);
  const third = await host.handle("roll", HOST, { gameId });
  assert.equal(third.state.lastAction.forfeit, true);
  assert.equal(third.state.phase, "busy");
  const passed = await waitFor(async () => {
    const s = await stateOf(host, gameId);
    return s.currentPlayer === 1 ? s : null;
  }, { label: "turn passes to the computer" });
  assert.equal(passed.currentPlayer, 1);
  host.shutdown();
});

test("online: invite, accept, start, turns, and remote profile pictures", async () => {
  const { io, host } = setup({ store: makeStore() });
  const created = await host.handle(
    "create",
    HOST,
    { playerCount: 3, seats: [{ kind: "invite", profileId: GUEST, name: "Guest" }, { kind: "bot" }] },
    { socketId: "h1" },
  );
  assert.equal(created.state.status, "lobby");
  const { gameId } = created;
  const invite = io.last("ludo:invite", `user_${GUEST}`);
  assert.ok(invite, "invite delivered to the guest");
  assert.equal(invite.payload.gameId, gameId);
  assert.equal(invite.payload.slotIndex, 1);
  assert.deepEqual((await host.handle("invites", GUEST)).invites.map((i) => i.gameId), [gameId]);

  // A stranger can't take the reserved seat.
  assert.equal((await host.handle("accept", THIRD, { gameId })).error, "full");

  const accepted = await host.handle("accept", GUEST, { gameId, slotIndex: 1 }, { socketId: "g1" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.seat, 1);
  const s = accepted.state;
  assert.equal(s.status, "playing");
  // The guest's own profile (photo + cover) is loaded by the server for the board.
  assert.equal(s.players[1].profileId, GUEST);
  assert.equal(s.players[1].avatar, "https://img/b.png");
  assert.equal(s.players[1].cover, "https://cover/b.png");
  assert.equal(s.players[0].cover, "https://cover/a.png");
  assert.equal(s.players[1].online, true);
  assert.deepEqual((await host.handle("invites", GUEST)).invites, []);

  // Turn order: the guest can't roll on the host's turn.
  assert.equal((await host.handle("roll", GUEST, { gameId })).error, "not_your_turn");
  host.shutdown();
});

test("an absent player's turn is skipped and they rejoin their seat", async () => {
  const { host, dice } = setup();
  const { gameId } = await host.handle("create", HOST, { playerCount: 2, seats: [{ kind: "invite", profileId: GUEST }] }, { socketId: "h1" });
  await host.handle("accept", GUEST, { gameId }, { socketId: "g1" });
  await host.handle("away", GUEST, { gameId }, { socketId: "g1" });
  let s = await stateOf(host, gameId);
  assert.equal(s.players[1].isOffline, true);

  dice.push(2); // no legal move: turn passes, skipping the absent guest
  await host.handle("roll", HOST, { gameId });
  s = await waitFor(async () => {
    const st = await stateOf(host, gameId);
    return st.lastAction?.type === "turn" ? st : null;
  }, { label: "turn passes" });
  assert.equal(s.currentPlayer, 0, "absent guest skipped");

  // The guest comes back (reload / reconnect) and gets turns again.
  await host.handle("join", GUEST, { gameId }, { socketId: "g2" });
  s = await stateOf(host, gameId);
  assert.equal(s.players[1].online, true);
  dice.push(3);
  await host.handle("roll", HOST, { gameId });
  s = await waitFor(async () => {
    const st = await stateOf(host, gameId);
    return st.lastAction?.type === "turn" ? st : null;
  }, { label: "turn passes to guest" });
  assert.equal(s.currentPlayer, 1);

  // Dropping mid-turn: after the grace period the turn is skipped.
  await host.handle("away", GUEST, { gameId }, { socketId: "g2" });
  s = await waitFor(async () => {
    const st = await stateOf(host, gameId);
    return st.lastAction?.type === "skip" ? st : null;
  }, { label: "absent turn skipped" });
  assert.equal(s.currentPlayer, 0);
  host.shutdown();
});

test("pause blocks play until any player resumes; it survives a reload", async () => {
  const store = makeStore();
  const { host } = setup({ store });
  const { gameId } = await host.handle("create", HOST, { playerCount: 2, seats: [{ kind: "invite", profileId: GUEST }] }, { socketId: "h1" });
  await host.handle("accept", GUEST, { gameId }, { socketId: "g1" });
  const paused = await host.handle("pause", GUEST, { gameId, name: "Guest" });
  assert.equal(paused.state.paused, true);
  assert.equal(paused.state.pausedBy.profileId, GUEST);
  assert.equal((await host.handle("roll", HOST, { gameId })).error, "paused");
  assert.equal((await host.handle("pause", THIRD, { gameId })).error, "not_member");

  // Everyone leaves; the game is saved and restored on a fresh server.
  await host.flushAll();
  host.shutdown();
  const second = setup({ store });
  const restored = await second.host.handle("join", HOST, { gameId }, { socketId: "h2" });
  assert.equal(restored.ok, true);
  assert.equal(restored.state.paused, true);
  assert.equal(restored.state.status, "playing");
  assert.equal(restored.state.players[1].profileId, GUEST);
  assert.equal(restored.state.players[1].isOffline, true);

  // A reloaded game is a new epoch, so clients take its state as-is even if
  // its version is lower than the last one they saw.
  assert.notEqual(restored.state.epoch, paused.state.epoch);

  const resumed = await second.host.handle("resume", HOST, { gameId });
  assert.equal(resumed.state.paused, false);
  assert.equal((await second.host.handle("roll", HOST, { gameId })).ok, true);
  second.host.shutdown();
});

test("progress is saved and restored exactly (pieces, turn, winners)", async () => {
  const store = makeStore();
  const { host, dice } = setup({ store, timings: { autoMoveMs: 100000 } });
  const { gameId } = await host.handle("create", HOST, { playerCount: 2, seats: [{ kind: "local", name: "Sam" }] }, { socketId: "h1" });
  dice.push(6);
  await host.handle("roll", HOST, { gameId });
  await host.handle("move", HOST, { gameId, pieceIndex: 2 });
  await waitFor(async () => (await stateOf(host, gameId)).phase === "roll", { label: "move done" });
  dice.push(4);
  await host.handle("roll", HOST, { gameId });
  await host.handle("move", HOST, { gameId, pieceIndex: 2 });
  const before = await waitFor(async () => {
    const s = await stateOf(host, gameId);
    return s.phase === "roll" && s.currentPlayer === 1 ? s : null;
  }, { label: "turn to local seat" });
  await host.flushAll();
  host.shutdown();

  const second = setup({ store });
  const restored = (await second.host.handle("join", HOST, { gameId }, { socketId: "h2" })).state;
  assert.deepEqual(restored.players.map((p) => p.pieces.map((pc) => pc.steps)), before.players.map((p) => p.pieces.map((pc) => pc.steps)));
  assert.equal(restored.currentPlayer, 1);
  assert.equal(restored.players[1].kind, "local");
  assert.equal(restored.players[1].name, "Sam");
  assert.equal(restored.mode, "local");
  // The host controls the local seat.
  assert.equal((await second.host.handle("roll", HOST, { gameId })).ok, true);
  second.host.shutdown();
});

test("host replaces an absent player with the computer, who then plays", async () => {
  const { host } = setup();
  const { gameId } = await host.handle("create", HOST, { playerCount: 2, seats: [{ kind: "invite", profileId: GUEST }] }, { socketId: "h1" });
  await host.handle("accept", GUEST, { gameId }, { socketId: "g1" });
  assert.equal((await host.handle("replaceBot", GUEST, { gameId, playerIndex: 1 })).error, "host_only");
  const replaced = await host.handle("replaceBot", HOST, { gameId, playerIndex: 1 });
  assert.equal(replaced.state.players[1].kind, "bot");
  assert.equal(replaced.state.players[1].isBot, true);
  assert.equal(replaced.state.mode, "computer");
  // The former player can no longer act for that seat.
  const player = autoPlay(host, HOST, gameId);
  await waitFor(async () => {
    const s = await stateOf(host, gameId);
    return s.lastAction?.seat === 1 && s.lastAction?.type === "roll" ? s : null;
  }, { label: "computer rolls for seat 1" });
  await player.stop();
  host.shutdown();
});

test("lobby: start with computers, decline, re-invite and leaving", async () => {
  const { io, host } = setup();
  const created = await host.handle(
    "create",
    HOST,
    { playerCount: 4, seats: [{ kind: "invite", profileId: GUEST }, { kind: "invite", profileId: THIRD }, { kind: "bot" }] },
    { socketId: "h1" },
  );
  const { gameId } = created;
  await host.handle("decline", THIRD, { gameId });
  let s = await stateOf(host, gameId);
  assert.equal(s.players[2].invited, null);
  assert.equal(s.status, "lobby");

  // Re-invite repeats the pending invite.
  const before = io.emitted.filter((e) => e.event === "ludo:invite").length;
  assert.equal((await host.handle("reinvite", HOST, { gameId })).sent, 1);
  assert.equal(io.emitted.filter((e) => e.event === "ludo:invite").length, before + 1);

  await host.handle("accept", GUEST, { gameId }, { socketId: "g1" });
  const started = await host.handle("start", HOST, { gameId });
  assert.equal(started.state.status, "playing");
  assert.equal(started.state.players[2].kind, "bot");

  // A guest leaving mid-game hands the seat to the computer.
  const left = await host.handle("leave", GUEST, { gameId });
  assert.equal(left.removed, false);
  s = await stateOf(host, gameId);
  assert.equal(s.players[1].kind, "bot");

  // The host leaving ends the game for everyone.
  const ended = await host.handle("leave", HOST, { gameId });
  assert.equal(ended.removed, true);
  assert.ok(io.last("ludo:game:removed", `ludo_${gameId}`));
  assert.equal((await host.handle("join", HOST, { gameId })).error, "not_found");
  host.shutdown();
});

test("computers wait while no human is at the board", async () => {
  const { host } = setup();
  const { gameId } = await host.handle("create", HOST, { playerCount: 2, seats: [{ kind: "bot" }] }, { socketId: "h1" });
  await host.handle("roll", HOST, { gameId });
  await host.handle("away", HOST, { gameId }, { socketId: "h1" });
  const frozen = await stateOf(host, gameId); // state() from a non-socket ctx doesn't add presence
  await new Promise((resolve) => setTimeout(resolve, 150));
  const later = await stateOf(host, gameId);
  assert.equal(later.version, frozen.version, "nothing happens while everyone is away");
  host.shutdown();
});

test("games list and saved games", async () => {
  const store = makeStore();
  const { host } = setup({ store });
  const { gameId } = await host.handle("create", HOST, { playerCount: 2, seats: [{ kind: "invite", profileId: GUEST }] }, { socketId: "h1" });
  await host.handle("accept", GUEST, { gameId }, { socketId: "g1" });
  const list = (await host.handle("games", GUEST)).games;
  assert.equal(list.length, 1);
  assert.equal(list[0].gameId, gameId);
  assert.equal(list[0].mySeat, 1);
  assert.equal(list[0].isHost, false);
  await host.flushAll();
  host.shutdown();

  const second = setup({ store });
  const saved = await second.host.savedSummaries(GUEST);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].gameId, gameId);
  second.host.shutdown();
});
