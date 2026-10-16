// Server-hosted Ludo. The server owns every game: it rolls the dice, checks
// and applies moves, plays the computer seats, skips absent players, keeps
// pauses, and saves each change. Clients only send intents (roll, move a
// piece, pause, invite, ...) and draw the state they receive.
//
// Each game is broadcast to the socket room `ludo_<gameId>` as `ludo:state`.
// A state carries a `version` (strictly increasing) and the `lastAction` that
// produced it, so clients can animate the dice and the token that moved.

const crypto = require("crypto");
const {
  PIECES_PER_PLAYER,
  colorFor,
  colorNameFor,
  rulesFor,
  turnOrderFor,
} = require("./engine");

const DEFAULT_TIMINGS = {
  stepMs: 150, // per square a token moves; clients animate at this pace
  moveSettleMs: 350, // after a token lands, before the next turn starts
  captureMs: 450, // extra when a piece is sent home
  winMs: 900, // extra when a player brings their last piece home
  passMs: 1300, // a roll with no legal move (or a third six) stays visible
  autoMoveMs: 900, // only one possible move: played for the player
  botRollMs: 800,
  botMoveMs: 1000, // after a computer's roll, before it moves
  offlineGraceMs: 8000, // a player who drops mid-turn gets this long to return
  presenceTtlMs: 15000, // clients heartbeat every few seconds while on the board
  sweepMs: 2000,
  saveDebounceMs: 250,
  idleEvictMs: 15 * 60 * 1000, // nobody on the board: drop from memory (it's saved)
  endedEvictMs: 5 * 60 * 1000,
};

const SEAT_KINDS = new Set(["human", "bot", "local", "open"]);

const str = (value) => (value == null ? "" : String(value));
const cleanText = (value, max = 80) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const cleanUrl = (value) =>
  typeof value === "string" && value.length <= 4096 ? value.trim() : "";
const isHumanId = (value) => {
  const id = str(value);
  return Boolean(id) && id !== "local" && id !== "null" && id !== "undefined" && !id.startsWith("bot-");
};

const fail = (error, message) => ({ ok: false, error, message: message || error });

const newGameId = () =>
  `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;

function createLudoHost(options = {}) {
  const {
    io,
    store = null,
    hooks = {},
    pathLength = Number(process.env.LUDO_PATH_LENGTH) || undefined,
    log = () => {},
  } = options;
  const timings = { ...DEFAULT_TIMINGS, ...(options.timings || {}) };
  const now = options.now || (() => Date.now());
  const randomDie = options.randomDie || (() => crypto.randomInt(1, 7));

  const games = new Map(); // gameId -> game
  const hydrating = new Map(); // gameId -> Promise<game|null>

  // ---------------------------------------------------------------- helpers

  const rulesOf = (g) => rulesFor(g.pathLength);
  const room = (gameId) => `ludo_${gameId}`;
  const userRoom = (profileId) => `user_${profileId}`;

  const emitTo = (target, event, payload) => {
    try {
      io?.to(target).emit(event, payload);
    } catch (_e) {}
  };

  const isOnline = (g, profileId) => {
    const sockets = g.presence.get(str(profileId));
    if (!sockets) return false;
    const cutoff = now() - timings.presenceTtlMs;
    for (const ts of sockets.values()) if (ts >= cutoff) return true;
    return false;
  };

  const seatController = (g, index) => {
    const seat = g.seats[index];
    if (!seat) return "";
    if (seat.kind === "human") return str(seat.profileId);
    if (seat.kind === "local") return g.hostId;
    return "";
  };

  const seatOnline = (g, index) => {
    const seat = g.seats[index];
    if (!seat) return false;
    if (seat.kind === "bot") return true;
    if (seat.kind === "open") return false;
    return isOnline(g, seatController(g, index));
  };

  const isMember = (g, profileId) => {
    const pid = str(profileId);
    if (!pid) return false;
    if (pid === g.hostId) return true;
    return g.seats.some((seat) => seat.kind === "human" && str(seat.profileId) === pid);
  };

  const seatIndexOf = (g, profileId) => {
    const pid = str(profileId);
    const index = g.seats.findIndex((seat) => seat.kind === "human" && str(seat.profileId) === pid);
    if (index >= 0) return index;
    return pid && pid === g.hostId ? 0 : -1;
  };

  const canControl = (g, profileId, index) => {
    const controller = seatController(g, index);
    return Boolean(controller) && controller === str(profileId);
  };

  const isFinished = (g, index) => g.seats[index]?.rank != null;

  const canTakeTurn = (g, index) => !isFinished(g, index) && seatOnline(g, index);

  const anyControllerPresent = (g) =>
    g.seats.some((seat, index) => seat.kind !== "bot" && seat.kind !== "open" && seatOnline(g, index));

  const humanCount = (g) =>
    g.seats.filter((seat) => seat.kind === "human").length +
    g.seats.filter((seat) => seat.kind === "open" && seat.invited).length;

  // ------------------------------------------------------------ public view

  const seatProfileId = (seat, index) => {
    if (seat.kind === "human") return str(seat.profileId);
    if (seat.kind === "bot") return `bot-${index}`;
    return null;
  };

  const publicState = (g) => {
    const rules = rulesOf(g);
    const count = g.playerCount;
    const players = g.seats.map((seat, index) => {
      const color = colorFor(index, count);
      const online = seatOnline(g, index);
      return {
        id: index,
        seat: index,
        kind: seat.kind,
        name: seat.name,
        color,
        colorName: colorNameFor(index, count),
        avatar: seat.avatar || null,
        cover: seat.cover || null,
        profileId: seatProfileId(seat, index),
        isHost: index === 0,
        isBot: seat.kind === "bot",
        isLocal: seat.kind === "local",
        isOpen: seat.kind === "open",
        online,
        isActive: seat.kind !== "open",
        isOffline: (seat.kind === "human" || seat.kind === "local") && !online,
        invited: seat.invited
          ? {
              profileId: seat.invited.profileId,
              name: seat.invited.name,
              avatar: seat.invited.avatar || null,
            }
          : null,
        rank: seat.rank ?? null,
        finished: seat.rank != null,
        pieces: seat.pieces.map((steps, piece) => ({
          id: piece,
          color,
          steps,
          isHome: steps <= 0,
          isInPlay: steps > 0 && steps < rules.maxSteps,
        })),
      };
    });
    const summary = (index) => ({
      id: index,
      seat: index,
      name: g.seats[index]?.name,
      color: colorFor(index, count),
      avatar: g.seats[index]?.avatar || null,
      profileId: seatProfileId(g.seats[index] || {}, index),
      rank: g.seats[index]?.rank ?? null,
    });
    return {
      gameId: g.gameId,
      version: g.version,
      serverTs: now(),
      hostId: g.hostId,
      mode: g.mode,
      status: g.status,
      playerCount: count,
      selectedPlayerCount: count,
      maxSteps: rules.maxSteps,
      pathLength: rules.pathLength,
      stepMs: timings.stepMs,
      gameStarted: g.status !== "lobby",
      gameEnded: g.status === "ended",
      currentPlayer: g.current,
      phase: g.status === "playing" ? g.phase : "idle",
      diceValue: g.phase === "move" ? g.dice : 0,
      movable: g.phase === "move" ? [...g.movable] : [],
      sixes: g.sixes,
      turnStartedAt: g.turnStartedAt,
      players,
      winners: g.winners.map(summary),
      standings: g.status === "ended" ? standingsOf(g).map(summary) : [],
      paused: Boolean(g.paused),
      pausedAt: g.paused ? g.paused.at : null,
      pausedBy: g.paused ? { profileId: g.paused.profileId, name: g.paused.name } : null,
      lastAction: g.lastAction,
      createdAt: g.createdAt,
    };
  };

  const standingsOf = (g) => {
    const rules = rulesOf(g);
    const finished = [...g.winners];
    const rest = g.seats
      .map((seat, index) => ({ index, progress: rules.progressOf(seat.pieces) }))
      .filter(({ index }) => !finished.includes(index) && g.seats[index].kind !== "open")
      .sort((a, b) => b.progress - a.progress)
      .map(({ index }) => index);
    return [...finished, ...rest];
  };

  const summaryOf = (g, profileId) => {
    const rules = rulesOf(g);
    const total = g.seats.length * PIECES_PER_PLAYER * rules.maxSteps || 1;
    const progress = Math.round(
      (g.seats.reduce((sum, seat) => sum + rules.progressOf(seat.pieces), 0) / total) * 100,
    );
    const mySeat = seatIndexOf(g, profileId);
    return {
      gameId: g.gameId,
      status: g.status,
      mode: g.mode,
      hostId: g.hostId,
      isHost: str(profileId) === g.hostId,
      mySeat,
      playerCount: g.playerCount,
      paused: Boolean(g.paused),
      pausedBy: g.paused ? { profileId: g.paused.profileId, name: g.paused.name } : null,
      currentPlayer: g.current,
      progress,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      players: g.seats.map((seat, index) => ({
        seat: index,
        kind: seat.kind,
        name: seat.name,
        avatar: seat.avatar || null,
        color: colorFor(index, g.playerCount),
        profileId: seatProfileId(seat, index),
        online: g.live ? seatOnline(g, index) : seat.kind === "bot",
      })),
    };
  };

  // ------------------------------------------------------------- lifecycle

  const touch = (g, action) => {
    g.version += 1;
    g.updatedAt = now();
    if (action) {
      g.actionSeq += 1;
      g.lastAction = { id: g.actionSeq, at: now(), ...action };
    }
  };

  const broadcast = (g) => {
    if (g.removed) return;
    emitTo(room(g.gameId), "ludo:state", publicState(g));
  };

  const commit = (g, action, { save = true } = {}) => {
    touch(g, action);
    broadcast(g);
    if (save) scheduleSave(g);
    schedule(g);
  };

  // ---- persistence

  const toRecord = (g) => {
    const rules = rulesOf(g);
    return {
      gameId: g.gameId,
      host: g.hostId,
      players: g.seats.map((seat, index) => ({
        id: index,
        kind: seat.kind,
        name: seat.name,
        color: colorFor(index, g.playerCount),
        avatar: seat.avatar || null,
        cover: seat.cover || null,
        profileId: seat.kind === "human" ? str(seat.profileId) : null,
        isBot: seat.kind === "bot",
        invited: seat.invited || null,
        rank: seat.rank ?? null,
        ...(index === 0 ? { gameMode: g.mode, pathLength: g.pathLength } : {}),
        pieces: seat.pieces.map((steps, piece) => ({
          id: piece,
          color: colorFor(index, g.playerCount),
          steps,
          isHome: steps <= 0,
          isInPlay: steps > 0 && steps < rules.maxSteps,
        })),
      })),
      playerProfileIds: [
        ...new Set(g.seats.filter((seat) => seat.kind === "human").map((seat) => str(seat.profileId))),
      ],
      currentPlayer: g.current,
      diceValue: g.phase === "move" ? g.dice : 0,
      gameStarted: g.status !== "lobby",
      gameEnded: g.status === "ended",
      winners: g.winners.map((index) => ({
        id: index,
        name: g.seats[index]?.name,
        color: colorFor(index, g.playerCount),
        avatar: g.seats[index]?.avatar || null,
        profileId: g.seats[index]?.kind === "human" ? str(g.seats[index].profileId) : null,
      })),
      selectedPlayerCount: g.playerCount,
      paused: Boolean(g.paused),
      pausedAt: g.paused ? new Date(g.paused.at) : null,
      pausedBy: g.paused ? { profileId: g.paused.profileId, name: g.paused.name } : null,
      stateVersion: g.version,
    };
  };

  const scheduleSave = (g) => {
    if (!store || g.removed) return;
    g.dirty = true;
    if (g.saveTimer) return;
    g.saveTimer = setTimeout(() => {
      g.saveTimer = null;
      flushSave(g);
    }, timings.saveDebounceMs);
  };

  const flushSave = (g) => {
    if (!store || g.removed || !g.dirty) return Promise.resolve();
    if (g.saving) {
      g.saveQueued = true;
      return g.saving;
    }
    g.dirty = false;
    const record = toRecord(g);
    g.saving = Promise.resolve()
      .then(() => store.saveGame(record))
      .catch((error) => log("save-failed", { gameId: g.gameId, message: error?.message }))
      .then(() => {
        g.saving = null;
        if (g.saveQueued) {
          g.saveQueued = false;
          return flushSave(g);
        }
        return undefined;
      });
    return g.saving;
  };

  const fromRecord = (row) => {
    const players = Array.isArray(row.players) ? row.players : [];
    const count = [2, 3, 4].includes(Number(row.selectedPlayerCount))
      ? Number(row.selectedPlayerCount)
      : Math.max(2, Math.min(4, players.length || 2));
    const meta = players[0] || {};
    const g = blankGame({
      gameId: str(row.gameId),
      hostId: str(row.host),
      playerCount: count,
      pathLength: Number(meta.pathLength) || pathLength,
    });
    const started = Boolean(row.gameStarted);
    for (let index = 0; index < count; index += 1) {
      const p = players[index] || {};
      let kind = SEAT_KINDS.has(p.kind) ? p.kind : null;
      const pid = typeof p.profileId === "object" && p.profileId ? str(p.profileId._id || p.profileId.id) : str(p.profileId);
      if (!kind) {
        // Saved by the old host-run clients.
        if (index === 0) kind = "human";
        else if (p.isBot) kind = "bot";
        else if (isHumanId(pid)) kind = "human";
        else kind = started ? "bot" : "open";
      }
      const pieces = Array.from({ length: PIECES_PER_PLAYER }, (_, piece) => {
        const steps = Number(p.pieces?.[piece]?.steps);
        return Number.isFinite(steps) && steps > 0 ? Math.trunc(steps) : 0;
      });
      g.seats[index] = {
        kind,
        profileId: kind === "human" ? (index === 0 && !isHumanId(pid) ? g.hostId : pid) : null,
        name: cleanText(p.name) || (kind === "bot" ? `Computer ${index}` : colorNameFor(index, count)),
        avatar: cleanUrl(p.avatar) || null,
        cover: cleanUrl(p.cover) || null,
        invited: kind === "open" && p.invited?.profileId ? { ...p.invited } : null,
        rank: Number.isInteger(p.rank) ? p.rank : null,
        pieces,
      };
    }
    const rules = rulesOf(g);
    const winners = (Array.isArray(row.winners) ? row.winners : [])
      .map((w) => Number(w?.id))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < count);
    g.winners = [...new Set(winners)];
    g.winners.forEach((index, position) => {
      if (g.seats[index].rank == null) g.seats[index].rank = position + 1;
    });
    g.seats.forEach((seat, index) => {
      if (seat.rank == null && rules.piecesFinished(seat.pieces) && !g.winners.includes(index)) {
        g.winners.push(index);
        seat.rank = g.winners.length;
      }
    });
    g.mode = ["online", "computer", "local"].includes(meta.gameMode) ? meta.gameMode : deriveMode(g);
    g.status = row.gameEnded ? "ended" : started ? "playing" : "lobby";
    g.current = Number.isInteger(row.currentPlayer) && row.currentPlayer < count ? row.currentPlayer : 0;
    g.phase = "roll";
    g.dice = 0;
    g.version = Math.max(0, Number(row.stateVersion) || 0) + 1;
    g.createdAt = new Date(row.createdAt || now()).getTime();
    g.updatedAt = new Date(row.lastUpdated || row.updatedAt || now()).getTime();
    g.turnStartedAt = now();
    if (row.paused) {
      const by = row.pausedBy || {};
      g.paused = {
        profileId: str(by.profileId),
        name: cleanText(by.name) || "A player",
        at: row.pausedAt ? new Date(row.pausedAt).getTime() : now(),
      };
    }
    // Everyone starts "away" until their client rejoins.
    g.seats.forEach((seat, index) => {
      const controller = seatController(g, index);
      if (controller) g.offlineSince.set(controller, now());
    });
    if (g.status === "playing" && isFinished(g, g.current)) {
      g.current = nextSeat(g, g.current);
    }
    return g;
  };

  const deriveMode = (g) => {
    if (g.seats.some((seat, index) => index > 0 && (seat.kind === "human" || seat.kind === "open"))) return "online";
    if (g.seats.some((seat) => seat.kind === "local")) return "local";
    return "computer";
  };

  const blankGame = ({ gameId, hostId, playerCount, pathLength: length }) => ({
    gameId,
    hostId,
    mode: "online",
    playerCount,
    pathLength: rulesFor(length).pathLength,
    status: "lobby",
    seats: [],
    current: 0,
    phase: "roll",
    dice: 0,
    movable: [],
    sixes: 0,
    autoMoveAt: 0,
    botMoveAt: 0,
    busy: null,
    turnStartedAt: now(),
    winners: [],
    paused: null,
    version: 1,
    actionSeq: 0,
    lastAction: null,
    presence: new Map(), // profileId -> Map<socketId, lastSeen>
    offlineSince: new Map(), // profileId -> ts
    invites: new Map(), // profileId -> invite
    createdAt: now(),
    updatedAt: now(),
    timer: null,
    saveTimer: null,
    saving: null,
    saveQueued: false,
    dirty: false,
    removed: false,
    live: true,
  });

  /** The game in memory, rebuilt from the database when needed. */
  const getGame = async (gameId) => {
    const id = str(gameId);
    if (!id) return null;
    const live = games.get(id);
    if (live) return live;
    if (!store) return null;
    if (hydrating.has(id)) return hydrating.get(id);
    const pending = Promise.resolve()
      .then(() => store.loadGame(id))
      .then((row) => {
        if (games.has(id)) return games.get(id);
        if (!row) return null;
        const g = fromRecord(row);
        games.set(id, g);
        log("game-restored", { gameId: id, status: g.status });
        return g;
      })
      .catch((error) => {
        log("restore-failed", { gameId: id, message: error?.message });
        return null;
      })
      .finally(() => hydrating.delete(id));
    hydrating.set(id, pending);
    return pending;
  };

  const removeGame = (g, reason) => {
    if (g.removed) return;
    g.removed = true;
    clearTimer(g);
    if (g.saveTimer) clearTimeout(g.saveTimer);
    g.saveTimer = null;
    games.delete(g.gameId);
    const invited = [...g.invites.keys()];
    g.invites.clear();
    invited.forEach((pid) => {
      hooks.onInvitesChanged?.(pid);
      store?.clearInviteNotifications?.(pid, g.gameId);
    });
    emitTo(room(g.gameId), "ludo:game:removed", { gameId: g.gameId, reason, serverTs: now() });
    if (store) {
      Promise.resolve(g.saving)
        .then(() => store.deleteGame(g.gameId))
        .catch(() => {});
    }
  };

  // ------------------------------------------------------------- turn flow

  const clearTimer = (g) => {
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
  };

  const setTimer = (g, delay, fn) => {
    clearTimer(g);
    g.timer = setTimeout(() => {
      g.timer = null;
      if (g.removed) return;
      try {
        fn();
      } catch (error) {
        log("timer-error", { gameId: g.gameId, message: error?.message, stack: error?.stack });
      }
    }, Math.max(0, delay));
  };

  /** Decides what the game waits for next and sets the one timer that does it. */
  const schedule = (g) => {
    clearTimer(g);
    if (g.removed || g.status !== "playing" || g.paused) return;
    // Nobody is at the board: the match waits (computers don't play alone).
    if (!anyControllerPresent(g)) return;
    const t = now();
    if (g.phase === "busy") {
      setTimer(g, (g.busy?.until || t) - t, () => finishBusy(g));
      return;
    }
    const seat = g.seats[g.current];
    if (!seat || isFinished(g, g.current)) {
      setTimer(g, 0, () => advanceTurn(g));
      return;
    }
    if (seat.kind === "bot") {
      if (g.phase === "roll") setTimer(g, timings.botRollMs, () => rollFor(g, null));
      else setTimer(g, (g.botMoveAt || t) - t, () => botMove(g));
      return;
    }
    if (!seatOnline(g, g.current)) {
      const controller = seatController(g, g.current);
      const since = Math.max(g.offlineSince.get(controller) || t, g.turnStartedAt || t);
      setTimer(g, since + timings.offlineGraceMs - t, () => playForAbsent(g));
      return;
    }
    if (g.phase === "move" && g.autoMoveAt) {
      setTimer(g, g.autoMoveAt - t, () => {
        if (g.phase === "move" && g.movable.length) moveFor(g, g.movable[0], { auto: true });
      });
    }
  };

  const startTurn = (g, index, { keepSixes = false } = {}) => {
    g.current = index;
    g.phase = "roll";
    g.dice = 0;
    g.movable = [];
    g.autoMoveAt = 0;
    g.botMoveAt = 0;
    g.busy = null;
    g.turnStartedAt = now();
    if (!keepSixes) g.sixes = 0;
  };

  const nextSeat = (g, from) => {
    const order = turnOrderFor(g.playerCount);
    const start = order.indexOf(from);
    let fallback = null;
    for (let step = 1; step <= order.length; step += 1) {
      const candidate = order[(Math.max(start, 0) + step) % order.length];
      if (isFinished(g, candidate) || g.seats[candidate]?.kind === "open") continue;
      if (fallback == null) fallback = candidate;
      if (canTakeTurn(g, candidate)) return candidate;
    }
    return fallback == null ? from : fallback;
  };

  const advanceTurn = (g) => {
    startTurn(g, nextSeat(g, g.current));
    commit(g, { type: "turn", seat: g.current });
  };

  const finishBusy = (g) => {
    const then = g.busy?.then || "advance";
    g.busy = null;
    if (then === "end") {
      endGame(g);
      return;
    }
    if (then === "same" && !isFinished(g, g.current)) {
      startTurn(g, g.current, { keepSixes: true });
      commit(g, { type: "turn", seat: g.current, again: true });
      return;
    }
    advanceTurn(g);
  };

  const rollFor = (g, forced) => {
    if (g.status !== "playing" || g.paused || g.phase !== "roll") return false;
    const rules = rulesOf(g);
    const seatIndex = g.current;
    const seat = g.seats[seatIndex];
    const value = Number.isInteger(forced) && forced >= 1 && forced <= 6 ? forced : randomDie();
    const t = now();
    g.dice = value;
    g.sixes = value === 6 ? g.sixes + 1 : 0;
    const legal = rules.legalPieces(seat.pieces, value);
    const action = { type: "roll", seat: seatIndex, value, legal };
    if (g.sixes >= 3) {
      g.sixes = 0;
      g.movable = [];
      g.phase = "busy";
      g.busy = { until: t + timings.passMs, then: "advance" };
      action.forfeit = true;
    } else if (legal.length === 0) {
      g.movable = [];
      g.phase = "busy";
      g.busy = { until: t + timings.passMs, then: "advance" };
      action.noMove = true;
    } else {
      g.phase = "move";
      g.movable = legal;
      g.autoMoveAt = 0;
      g.botMoveAt = 0;
      if (seat.kind === "bot") g.botMoveAt = t + timings.botMoveMs;
      else if (rules.distinctMoves(seat.pieces, legal) === 1) g.autoMoveAt = t + timings.autoMoveMs;
    }
    commit(g, action);
    return true;
  };

  const moveFor = (g, pieceIndex, { auto = false } = {}) => {
    if (g.status !== "playing" || g.paused || g.phase !== "move") return false;
    if (!g.movable.includes(pieceIndex)) return false;
    const rules = rulesOf(g);
    const seatIndex = g.current;
    const seat = g.seats[seatIndex];
    const from = seat.pieces[pieceIndex];
    const to = rules.targetSteps(from, g.dice);
    if (to < 0) return false;
    const dice = g.dice;
    seat.pieces[pieceIndex] = to;
    const captures = rules
      .capturesAfterMove(g.seats.map((s) => ({ pieces: s.pieces })), seatIndex, from, to, g.playerCount)
      .map((hit) => ({ seat: hit.seat, piece: hit.piece, from: g.seats[hit.seat].pieces[hit.piece] }));
    captures.forEach((hit) => {
      g.seats[hit.seat].pieces[hit.piece] = 0;
    });

    let won = false;
    if (seat.rank == null && rules.piecesFinished(seat.pieces)) {
      g.winners.push(seatIndex);
      seat.rank = g.winners.length;
      won = true;
    }
    const contenders = g.seats.filter((s) => s.kind !== "open" && s.rank == null).length;
    const gameOver = contenders <= 1;
    const keepTurn = !gameOver && !won && (dice === 6 || captures.length > 0);
    const squares = from <= 0 ? 1 : to - from;
    const t = now();
    g.phase = "busy";
    g.movable = [];
    g.autoMoveAt = 0;
    g.botMoveAt = 0;
    g.busy = {
      until:
        t +
        squares * timings.stepMs +
        timings.moveSettleMs +
        (captures.length ? timings.captureMs : 0) +
        (won ? timings.winMs : 0),
      then: gameOver ? "end" : keepTurn ? "same" : "advance",
    };
    commit(g, {
      type: "move",
      seat: seatIndex,
      piece: pieceIndex,
      from,
      to,
      dice,
      captures,
      finished: to >= rules.maxSteps,
      won,
      rank: won ? seat.rank : null,
      keepTurn,
      auto,
    });
    return true;
  };

  const botMove = (g) => {
    if (g.phase !== "move") return;
    const rules = rulesOf(g);
    const choice = rules.pickBotPiece(
      g.seats.map((s) => ({ pieces: s.pieces })),
      g.current,
      g.dice,
      g.playerCount,
      g.movable,
    );
    moveFor(g, choice >= 0 ? choice : g.movable[0], { auto: true });
  };

  // The player whose turn it is has been away longer than the grace period:
  // an unrolled turn is skipped, a rolled one is played for them.
  const playForAbsent = (g) => {
    if (g.status !== "playing" || g.paused || seatOnline(g, g.current)) {
      schedule(g);
      return;
    }
    if (g.phase === "move") {
      botMove(g);
      return;
    }
    if (g.phase === "roll") {
      const skipped = g.current;
      startTurn(g, nextSeat(g, skipped));
      commit(g, { type: "skip", seat: skipped, to: g.current });
    }
  };

  const startMatch = (g) => {
    g.status = "playing";
    g.mode = deriveMode(g);
    startTurn(g, 0);
    commit(g, { type: "start", seat: 0 });
  };

  const endGame = (g) => {
    g.status = "ended";
    g.phase = "roll";
    g.dice = 0;
    g.movable = [];
    g.paused = null;
    const standings = standingsOf(g);
    standings.forEach((index, position) => {
      if (g.seats[index].rank == null) g.seats[index].rank = position + 1;
    });
    commit(g, { type: "end", standings });
    // Keep the finished board around briefly for late reloads, then drop it.
    setTimeout(() => {
      if (games.get(g.gameId) === g && g.status === "ended") {
        games.delete(g.gameId);
        g.live = false;
      }
    }, timings.endedEvictMs).unref?.();
  };

  // ----------------------------------------------------------------- invites

  const inviteFor = (g, profileId, slotIndex, reinvite) => {
    const host = g.seats[0] || {};
    return {
      type: "ludo_invite",
      gameId: g.gameId,
      by: g.hostId,
      from: g.hostId,
      to: str(profileId),
      name: host.name || "A connect",
      avatar: host.avatar || null,
      cover: host.cover || null,
      playerCount: g.playerCount,
      slotIndex,
      reinvite: Boolean(reinvite),
      inviteId: `${g.gameId}:${profileId}:${now()}`,
      ts: now(),
    };
  };

  const sendInvite = (g, profileId, slotIndex, reinvite = false) => {
    const pid = str(profileId);
    if (!isHumanId(pid)) return null;
    const invite = inviteFor(g, pid, slotIndex, reinvite);
    g.invites.set(pid, invite);
    emitTo(userRoom(pid), "ludo:invite", { ...invite, serverTs: now() });
    hooks.onInvitesChanged?.(pid);
    if (store?.notifyInvite) {
      const host = g.seats[0] || {};
      store
        .notifyInvite(io, {
          to: pid,
          from: { profileId: g.hostId, name: host.name, avatar: host.avatar },
          gameId: g.gameId,
          slotIndex,
          playerCount: g.playerCount,
          reinvite,
          inviteId: invite.inviteId,
        })
        .catch(() => {});
    }
    return invite;
  };

  const clearInvite = (g, profileId) => {
    const pid = str(profileId);
    const had = g.invites.delete(pid);
    let seatChanged = false;
    g.seats.forEach((seat) => {
      if (seat.invited && str(seat.invited.profileId) === pid) {
        seat.invited = null;
        seatChanged = true;
      }
    });
    if (had) {
      hooks.onInvitesChanged?.(pid);
      store?.clearInviteNotifications?.(pid, g.gameId);
    }
    return had || seatChanged;
  };

  // ---------------------------------------------------------------- presence

  const presenceChanged = (g) => {
    // Online/offline flags changed: no new action, but a new version.
    touch(g, null);
    broadcast(g);
    schedule(g);
  };

  const addPresence = (g, profileId, socketId) => {
    const pid = str(profileId);
    if (!isMember(g, pid)) return;
    const wasOnline = isOnline(g, pid);
    const sockets = g.presence.get(pid) || new Map();
    sockets.set(str(socketId) || "default", now());
    g.presence.set(pid, sockets);
    if (!wasOnline) {
      g.offlineSince.delete(pid);
      presenceChanged(g);
    }
  };

  const removePresence = (g, profileId, socketId) => {
    const pid = str(profileId);
    const sockets = g.presence.get(pid);
    if (!sockets) return;
    const wasOnline = isOnline(g, pid);
    if (socketId) sockets.delete(str(socketId));
    else sockets.clear();
    if (sockets.size === 0) g.presence.delete(pid);
    if (wasOnline && !isOnline(g, pid)) {
      g.offlineSince.set(pid, now());
      presenceChanged(g);
    }
  };

  const sweep = () => {
    const t = now();
    games.forEach((g) => {
      if (g.removed) return;
      g.presence.forEach((sockets, pid) => {
        const wasOnline = [...sockets.values()].some((ts) => ts >= t - timings.presenceTtlMs - timings.sweepMs);
        for (const [socketId, ts] of sockets) {
          if (ts < t - timings.presenceTtlMs) sockets.delete(socketId);
        }
        if (sockets.size === 0) g.presence.delete(pid);
        if (wasOnline && !isOnline(g, pid)) {
          g.offlineSince.set(pid, t);
          presenceChanged(g);
        }
      });
      // Saved and nobody around: free the memory (reloaded on demand).
      if (
        store?.ready?.() &&
        g.presence.size === 0 &&
        !g.saving &&
        !g.saveTimer &&
        !g.dirty &&
        g.status !== "ended" &&
        t - g.updatedAt > timings.idleEvictMs
      ) {
        clearTimer(g);
        games.delete(g.gameId);
        g.live = false;
      }
    });
  };
  const sweepTimer = setInterval(sweep, timings.sweepMs);
  sweepTimer.unref?.();

  // ----------------------------------------------------------------- actions

  const loadProfiles = async (ids) => {
    if (!store?.loadProfiles) return new Map();
    try {
      return await store.loadProfiles(ids);
    } catch (_e) {
      return new Map();
    }
  };

  const identity = (profile, fallback = {}) => ({
    name: cleanText(profile?.fullName) || cleanText(fallback.fullName) || cleanText(fallback.name),
    avatar: cleanUrl(profile?.profilePic) || cleanUrl(fallback.profilePic) || cleanUrl(fallback.avatar) || null,
    cover:
      cleanUrl(profile?.coverPic) ||
      cleanUrl(fallback.coverPic) ||
      cleanUrl(fallback.cover) ||
      null,
  });

  const withGame = async (gameId, fn) => {
    const g = await getGame(gameId);
    if (!g || g.removed) return fail("not_found", "This game no longer exists.");
    return fn(g);
  };

  const ok = (g, extra = {}) => ({ ok: true, gameId: g.gameId, state: publicState(g), ...extra });

  const actions = {
    async create(profileId, payload = {}, ctx = {}) {
      const pid = str(profileId);
      if (!isHumanId(pid)) return fail("auth", "Sign in to play.");
      const count = Number(payload.playerCount);
      if (![2, 3, 4].includes(count)) return fail("bad_request", "Choose 2, 3 or 4 players.");
      const gameId = str(payload.gameId) || newGameId();
      if (games.has(gameId)) return fail("exists", "Game already exists.");

      const requested = Array.isArray(payload.seats) ? payload.seats : [];
      const inviteIds = requested
        .map((seat) => (seat?.kind === "invite" ? str(seat.profileId) : ""))
        .filter((id) => isHumanId(id) && id !== pid);
      const profiles = await loadProfiles([pid, ...inviteIds]);
      if (games.has(gameId)) return fail("exists", "Game already exists.");

      const g = blankGame({ gameId, hostId: pid, playerCount: count, pathLength });
      const host = identity(profiles.get(pid), payload.host || {});
      g.seats[0] = {
        kind: "human",
        profileId: pid,
        name: host.name || "Player 1",
        avatar: host.avatar,
        cover: host.cover,
        invited: null,
        rank: null,
        pieces: [0, 0, 0, 0],
      };
      const invitedAlready = new Set();
      for (let index = 1; index < count; index += 1) {
        const want = requested[index - 1] || {};
        const seat = { kind: "open", profileId: null, name: "", avatar: null, cover: null, invited: null, rank: null, pieces: [0, 0, 0, 0] };
        const target = str(want.profileId);
        if (want.kind === "bot") {
          seat.kind = "bot";
          seat.name = `Computer ${index}`;
        } else if (want.kind === "local") {
          seat.kind = "local";
          seat.name = cleanText(want.name) || colorNameFor(index, count);
          seat.avatar = cleanUrl(want.avatar) || null;
          seat.cover = cleanUrl(want.cover) || null;
        } else if (want.kind === "invite" && isHumanId(target) && target !== pid && !invitedAlready.has(target)) {
          invitedAlready.add(target);
          const who = identity(profiles.get(target), want);
          seat.invited = { profileId: target, name: who.name || "Invited player", avatar: who.avatar, cover: who.cover };
          seat.name = who.name || colorNameFor(index, count);
        } else {
          seat.name = colorNameFor(index, count);
        }
        g.seats[index] = seat;
      }
      g.mode = deriveMode(g);
      games.set(gameId, g);
      addPresenceQuiet(g, pid, ctx.socketId);

      g.seats.forEach((seat, index) => {
        if (seat.invited) sendInvite(g, seat.invited.profileId, index, false);
      });
      if (g.seats.some((seat) => seat.kind === "open")) {
        commit(g, { type: "create", seat: 0 });
      } else {
        g.status = "playing";
        startTurn(g, 0);
        commit(g, { type: "start", seat: 0 });
      }
      log("game-created", { gameId, mode: g.mode, players: count });
      return ok(g, { seat: 0 });
    },

    async join(profileId, payload = {}, ctx = {}) {
      return withGame(payload.gameId, (g) => {
        const pid = str(profileId);
        if (isMember(g, pid)) {
          addPresence(g, pid, ctx.socketId);
          if (g.invites.has(pid)) clearInvite(g, pid);
        }
        const seat = seatIndexOf(g, pid);
        const invite = g.invites.get(pid) || null;
        const openSeat = g.status === "lobby" && g.seats.some((s) => s.kind === "open" && (!s.invited || str(s.invited.profileId) === pid));
        return ok(g, { seat, invite, canJoin: seat < 0 && (Boolean(invite) || openSeat) });
      });
    },

    async accept(profileId, payload = {}, ctx = {}) {
      const pid = str(profileId);
      if (!isHumanId(pid)) return fail("auth", "Sign in to play.");
      return withGame(payload.gameId, async (g) => {
        if (isMember(g, pid)) {
          clearInvite(g, pid);
          addPresence(g, pid, ctx.socketId);
          return ok(g, { seat: seatIndexOf(g, pid) });
        }
        if (g.status !== "lobby") {
          clearInvite(g, pid);
          return fail("started", "This match has already started.");
        }
        const requested = Number(payload.slotIndex);
        const isOpenFor = (seat) => seat?.kind === "open" && (!seat.invited || str(seat.invited.profileId) === pid);
        let index = g.seats.findIndex((seat) => seat.kind === "open" && seat.invited && str(seat.invited.profileId) === pid);
        if (index < 0 && Number.isInteger(requested) && isOpenFor(g.seats[requested])) index = requested;
        if (index < 0) index = g.seats.findIndex((seat) => seat.kind === "open" && !seat.invited);
        if (index < 0) {
          clearInvite(g, pid);
          return fail("full", "This match is already full.");
        }
        const profiles = await loadProfiles([pid]);
        if (g.removed) return fail("not_found", "This game no longer exists.");
        if (g.seats[index].kind !== "open") return fail("full", "That seat was just taken.");
        const who = identity(profiles.get(pid), payload.connect || {});
        g.seats[index] = {
          ...g.seats[index],
          kind: "human",
          profileId: pid,
          name: who.name || g.seats[index].invited?.name || "Player",
          avatar: who.avatar || g.seats[index].invited?.avatar || null,
          cover: who.cover || g.seats[index].invited?.cover || null,
          invited: null,
        };
        clearInvite(g, pid);
        addPresenceQuiet(g, pid, ctx.socketId);
        if (g.seats.some((seat) => seat.kind === "open")) {
          commit(g, { type: "joined", seat: index });
        } else {
          touch(g, { type: "joined", seat: index });
          startMatch(g);
        }
        return ok(g, { seat: index });
      });
    },

    async decline(profileId, payload = {}) {
      return withGame(payload.gameId, (g) => {
        if (clearInvite(g, profileId)) commit(g, { type: "declined", profileId: str(profileId) });
        return ok(g);
      });
    },

    async invite(profileId, payload = {}) {
      const pid = str(profileId);
      const target = str(payload.to);
      return withGame(payload.gameId, async (g) => {
        if (pid !== g.hostId) return fail("host_only", "Only the host can invite players.");
        if (!isHumanId(target) || target === pid) return fail("bad_request", "Pick a connect to invite.");
        const seated = seatIndexOf(g, target);
        if (seated >= 0) {
          if (isOnline(g, target)) return fail("already_joined", "That player is already in the game.");
          sendInvite(g, target, seated, true);
          return ok(g, { seat: seated });
        }
        if (g.status !== "lobby") return fail("started", "Seats can only be filled before the match starts.");
        const requested = Number(payload.slotIndex);
        let index =
          Number.isInteger(requested) && g.seats[requested]?.kind === "open" ? requested : -1;
        if (index < 0) index = g.seats.findIndex((seat) => seat.kind === "open" && !seat.invited);
        if (index < 0) index = g.seats.findIndex((seat) => seat.kind === "open");
        if (index < 0) return fail("full", "Every seat is taken.");
        const profiles = await loadProfiles([target]);
        if (g.removed) return fail("not_found", "This game no longer exists.");
        const previous = g.seats[index].invited?.profileId;
        if (previous && str(previous) !== target) clearInvite(g, previous);
        g.seats.forEach((seat) => {
          if (seat.invited && str(seat.invited.profileId) === target) seat.invited = null;
        });
        const who = identity(profiles.get(target), payload.connect || {});
        g.seats[index].invited = { profileId: target, name: who.name || "Invited player", avatar: who.avatar, cover: who.cover };
        g.seats[index].name = who.name || g.seats[index].name;
        sendInvite(g, target, index, Boolean(payload.reinvite));
        commit(g, { type: "invited", seat: index, profileId: target });
        return ok(g, { seat: index });
      });
    },

    // Re-invite: nudge every absent player back, and repeat pending invites.
    async reinvite(profileId, payload = {}) {
      const pid = str(profileId);
      return withGame(payload.gameId, (g) => {
        if (pid !== g.hostId) return fail("host_only", "Only the host can re-invite players.");
        let sent = 0;
        g.seats.forEach((seat, index) => {
          if (index === 0) return;
          if (seat.kind === "human" && !isOnline(g, seat.profileId)) {
            if (sendInvite(g, seat.profileId, index, true)) sent += 1;
          } else if (seat.kind === "open" && seat.invited) {
            if (sendInvite(g, seat.invited.profileId, index, true)) sent += 1;
          }
        });
        return ok(g, { sent });
      });
    },

    async start(profileId, payload = {}) {
      const pid = str(profileId);
      return withGame(payload.gameId, (g) => {
        if (pid !== g.hostId) return fail("host_only", "Only the host can start the match.");
        if (g.status !== "lobby") return ok(g);
        g.seats.forEach((seat, index) => {
          if (seat.kind !== "open") return;
          if (seat.invited) clearInvite(g, seat.invited.profileId);
          g.seats[index] = { ...seat, kind: "bot", name: `Computer ${index}`, avatar: null, cover: null, invited: null };
        });
        startMatch(g);
        return ok(g);
      });
    },

    async roll(profileId, payload = {}) {
      return withGame(payload.gameId, (g) => {
        if (g.status !== "playing") return fail("not_playing", "The match isn't running.");
        if (g.paused) return fail("paused", "The game is paused.");
        if (!canControl(g, profileId, g.current)) return fail("not_your_turn", "It's not your turn.");
        if (g.phase !== "roll") return fail("wrong_phase", "Wait for your turn to roll.");
        // A chosen value (debug "control mode") only in games without other people.
        const forced = humanCount(g) <= 1 ? Number(payload.value) : null;
        rollFor(g, forced);
        return ok(g);
      });
    },

    async move(profileId, payload = {}) {
      return withGame(payload.gameId, (g) => {
        if (g.status !== "playing") return fail("not_playing", "The match isn't running.");
        if (g.paused) return fail("paused", "The game is paused.");
        if (!canControl(g, profileId, g.current)) return fail("not_your_turn", "It's not your turn.");
        if (g.phase !== "move") return fail("wrong_phase", "Roll the dice first.");
        const piece = Number(payload.pieceIndex);
        if (!g.movable.includes(piece)) return fail("illegal_move", "That piece can't move.");
        moveFor(g, piece);
        return ok(g);
      });
    },

    async pause(profileId, payload = {}) {
      const pid = str(profileId);
      return withGame(payload.gameId, (g) => {
        if (!isMember(g, pid)) return fail("not_member", "You're not in this game.");
        if (g.status !== "playing") return fail("not_playing", "Only a running match can be paused.");
        if (!g.paused) {
          const seat = g.seats[seatIndexOf(g, pid)] || g.seats[0];
          g.paused = { profileId: pid, name: cleanText(payload.name) || seat?.name || "A player", at: now() };
          commit(g, { type: "pause", profileId: pid });
        }
        return ok(g);
      });
    },

    async resume(profileId, payload = {}) {
      const pid = str(profileId);
      return withGame(payload.gameId, (g) => {
        if (!isMember(g, pid)) return fail("not_member", "You're not in this game.");
        if (g.paused) {
          g.paused = null;
          // A move that was animating when the game paused finishes now.
          if (g.phase === "busy" && g.busy) g.busy.until = Math.max(now() + 300, Math.min(g.busy.until, now() + 1500));
          if (g.phase === "move" && g.autoMoveAt) g.autoMoveAt = now() + timings.autoMoveMs;
          if (g.phase === "move" && g.botMoveAt) g.botMoveAt = now() + timings.botMoveMs;
          g.turnStartedAt = now();
          commit(g, { type: "resume", profileId: pid });
        }
        return ok(g);
      });
    },

    async replaceBot(profileId, payload = {}) {
      const pid = str(profileId);
      const index = Number(payload.playerIndex);
      return withGame(payload.gameId, (g) => {
        if (pid !== g.hostId) return fail("host_only", "Only the host can change players.");
        const seat = g.seats[index];
        if (!Number.isInteger(index) || index <= 0 || !seat) return fail("bad_request", "Pick another player's seat.");
        if (seat.kind === "bot") return ok(g);
        const replaced = seat.kind === "human" ? str(seat.profileId) : seat.invited ? str(seat.invited.profileId) : "";
        if (replaced) {
          clearInvite(g, replaced);
          g.presence.delete(replaced);
          g.offlineSince.delete(replaced);
          emitTo(userRoom(replaced), "ludo:seat:replaced", { gameId: g.gameId, seat: index, serverTs: now() });
        }
        g.seats[index] = { ...seat, kind: "bot", profileId: null, name: `Computer ${index}`, avatar: null, cover: null, invited: null };
        if (g.status === "lobby" && !g.seats.some((s) => s.kind === "open")) {
          touch(g, { type: "replaced", seat: index });
          startMatch(g);
        } else {
          g.mode = deriveMode(g);
          commit(g, { type: "replaced", seat: index });
        }
        return ok(g);
      });
    },

    async updateSeat(profileId, payload = {}) {
      const pid = str(profileId);
      const index = Number(payload.playerIndex);
      return withGame(payload.gameId, (g) => {
        if (pid !== g.hostId) return fail("host_only", "Only the host can edit players.");
        const seat = g.seats[index];
        if (!seat) return fail("bad_request", "Unknown seat.");
        if (seat.kind === "human") return fail("bad_request", "Players set their own name and photo.");
        const name = cleanText(payload.name);
        const avatar = cleanUrl(payload.avatar);
        if (name) seat.name = name;
        if (avatar && !avatar.startsWith("data:")) seat.avatar = avatar;
        commit(g, { type: "seat", seat: index });
        return ok(g);
      });
    },

    // Host: closes the game for everyone. Guest: hands the seat to the computer.
    async leave(profileId, payload = {}) {
      const pid = str(profileId);
      return withGame(payload.gameId, (g) => {
        if (pid === g.hostId) {
          removeGame(g, "host_left");
          return { ok: true, gameId: g.gameId, removed: true };
        }
        const index = seatIndexOf(g, pid);
        if (index < 0) {
          clearInvite(g, pid);
          return { ok: true, gameId: g.gameId, removed: false };
        }
        g.presence.delete(pid);
        g.offlineSince.delete(pid);
        const seat = g.seats[index];
        if (g.status === "lobby") {
          g.seats[index] = { ...seat, kind: "open", profileId: null, name: colorNameFor(index, g.playerCount), avatar: null, cover: null, invited: null };
        } else {
          g.seats[index] = { ...seat, kind: "bot", profileId: null, name: `Computer ${index}`, avatar: null, cover: null, invited: null };
        }
        g.mode = deriveMode(g);
        commit(g, { type: "left", seat: index, profileId: pid });
        if (!g.seats.some((s) => s.kind === "human")) removeGame(g, "empty");
        return { ok: true, gameId: g.gameId, removed: false };
      });
    },

    async state(profileId, payload = {}, ctx = {}) {
      return withGame(payload.gameId, (g) => {
        if (isMember(g, profileId) && ctx.socketId) addPresence(g, profileId, ctx.socketId);
        return ok(g, { seat: seatIndexOf(g, profileId), invite: g.invites.get(str(profileId)) || null });
      });
    },

    // Heartbeat from a client showing the board.
    async presence(profileId, payload = {}, ctx = {}) {
      const g = games.get(str(payload.gameId)) || (await getGame(payload.gameId));
      if (!g || g.removed) return fail("not_found");
      if (isMember(g, profileId)) addPresence(g, profileId, ctx.socketId);
      return { ok: true, gameId: g.gameId, version: g.version };
    },

    async away(profileId, payload = {}, ctx = {}) {
      const g = games.get(str(payload.gameId));
      if (g) removePresence(g, profileId, ctx.socketId);
      return { ok: true };
    },

    async games(profileId) {
      const pid = str(profileId);
      const list = [];
      games.forEach((g) => {
        if (!g.removed && g.status !== "ended" && isMember(g, pid)) list.push(summaryOf(g, pid));
      });
      return { ok: true, games: list };
    },

    async invites(profileId) {
      const pid = str(profileId);
      const list = [];
      games.forEach((g) => {
        const invite = g.invites.get(pid);
        if (invite && !g.removed && g.status !== "ended") list.push(invite);
      });
      return { ok: true, invites: list };
    },
  };

  // Presence without its own broadcast (the caller commits right after).
  const addPresenceQuiet = (g, profileId, socketId) => {
    const pid = str(profileId);
    const sockets = g.presence.get(pid) || new Map();
    sockets.set(str(socketId) || "default", now());
    g.presence.set(pid, sockets);
    g.offlineSince.delete(pid);
  };

  /** Runs one action; never throws. */
  const handle = async (action, profileId, payload = {}, ctx = {}) => {
    const fn = actions[action];
    if (!fn) return fail("unknown_action");
    try {
      return await fn(str(profileId), payload || {}, ctx || {});
    } catch (error) {
      log("action-error", { action, message: error?.message, stack: error?.stack });
      return fail("server_error", "Something went wrong. Try again.");
    }
  };

  /** Summaries of saved games (from the database) for the games list. */
  const savedSummaries = async (profileId) => {
    if (!store?.listGamesForPlayer) return [];
    try {
      const rows = await store.listGamesForPlayer(profileId);
      return rows
        .filter((row) => !games.has(str(row.gameId)))
        .map((row) => {
          const g = fromRecord(row);
          g.live = false;
          return summaryOf(g, profileId);
        });
    } catch (_e) {
      return [];
    }
  };

  const shutdown = () => {
    clearInterval(sweepTimer);
    games.forEach((g) => {
      clearTimer(g);
      if (g.saveTimer) clearTimeout(g.saveTimer);
    });
  };

  const flushAll = () => Promise.all([...games.values()].map((g) => flushSave(g)));

  return {
    handle,
    actions,
    savedSummaries,
    publicState,
    getGame,
    games,
    timings,
    shutdown,
    flushAll,
    newGameId,
    _sweep: sweep,
  };
}

module.exports = { createLudoHost, DEFAULT_TIMINGS, newGameId };
