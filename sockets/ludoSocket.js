// Minimal Ludo game socket relay for online play and device migration

const { debugLogger } = require("../utils/debugLogger");

// Saved matches live in MongoDB (the host persists every action). The socket
// server only keeps live games in memory, so after a restart, or once every
// player has gone, a paused/saved game is rebuilt from its stored snapshot.
// Loaded lazily: the socket relay also runs without a database (tests, and
// environments where mongoose can't load), and then simply skips saved games.
let mongooseLib;
const getMongoose = () => {
  if (mongooseLib === undefined) {
    try {
      mongooseLib = require("mongoose");
    } catch (_e) {
      mongooseLib = null;
    }
  }
  return mongooseLib;
};
const isObjectId = (value) =>
  Boolean(getMongoose()?.Types?.ObjectId?.isValid(String(value || "")));

let LudoGameModel = null;
const getLudoGameModel = () => {
  if (getMongoose()?.connection?.readyState !== 1) return null;
  if (!LudoGameModel) {
    try {
      LudoGameModel = require("../models/LudoGame");
    } catch (_e) {
      return null;
    }
  }
  return LudoGameModel;
};

const SAVED_GAME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const idString = (value) => {
  if (value == null) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
};

const docToSnapshot = (doc) => {
  const version = Math.max(Number(doc.stateVersion || 0), 0) + 1;
  return {
    gameId: doc.gameId,
    players: (doc.players || []).map((p, index) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      avatar: p.avatar,
      cover: p.cover,
      profileId: p.profileId ? idString(p.profileId) : p.isBot ? `bot-${index}` : undefined,
      isBot: Boolean(p.isBot),
      isActive: p.isActive !== false,
      pieces: (p.pieces || []).map((pc) => ({
        id: pc.id,
        color: pc.color,
        steps: pc.steps || 0,
        isHome: pc.isHome !== false && !(pc.steps > 0),
        isInPlay: Boolean(pc.isInPlay),
      })),
    })),
    currentPlayer: doc.currentPlayer || 0,
    // A restored game restarts the interrupted turn from a fresh roll.
    diceValue: 0,
    gameStarted: Boolean(doc.gameStarted),
    gameEnded: Boolean(doc.gameEnded),
    winners: doc.winners || [],
    selectedPlayerCount: doc.selectedPlayerCount || 4,
    paused: Boolean(doc.paused),
    pausedAt: doc.pausedAt ? new Date(doc.pausedAt).getTime() : undefined,
    pausedBy: doc.paused && doc.pausedBy
      ? { profileId: idString(doc.pausedBy.profileId), name: doc.pausedBy.name }
      : undefined,
    playersSeq: version,
    stateVersion: version,
    restoredFromSave: true,
  };
};

const persistPauseState = (gameId, pause) => {
  const Model = getLudoGameModel();
  if (!Model) return;
  const update = pause
    ? {
        paused: true,
        pausedAt: new Date(pause.at),
        pausedBy: {
          profileId: isObjectId(pause.profileId) ? pause.profileId : undefined,
          name: pause.name,
        },
      }
    : { paused: false, pausedAt: null, pausedBy: null };
  Model.updateOne({ gameId }, { $set: update }).catch(() => {});
};

const games = new Map(); // gameId -> { createdAt: number, lastPlayers: object, onlinePlayers: Set<profileId>, offlinePlayers: Map<profileId, timestamp> }
const userInvites = new Map(); // profileId -> [{ gameId, by, name, avatar, slotIndex, playerCount, ts }]
const playerSockets = new Map(); // profileId -> Set<socketId> (track all sockets for a profile)

const isHumanProfileId = (profileId) => {
  if (profileId == null || profileId === "") return false;
  const value = String(profileId);
  return value !== "local" && !value.startsWith("bot-");
};

const isOccupiedSeat = (seat, index) => {
  if (Number(index) === 0) return true;
  if (seat?.isBot) return true;
  return isHumanProfileId(seat?.profileId);
};

const countOccupiedSeats = (players = []) =>
  players.reduce(
    (count, seat, index) => count + (isOccupiedSeat(seat, index) ? 1 : 0),
    0,
  );

const bumpPlayersSeq = (snapshot = {}) => {
  const nextSeq =
    Math.max(
      Number(snapshot.playersSeq || 0),
      Number(snapshot.stateVersion || 0),
      0,
    ) + 1;
  snapshot.playersSeq = nextSeq;
  snapshot.stateVersion = nextSeq;
  return snapshot;
};

const mergeLobbyOccupants = (incomingPlayers = [], existingPlayers = []) => {
  if (!Array.isArray(incomingPlayers) || incomingPlayers.length === 0) {
    return incomingPlayers;
  }
  return incomingPlayers.map((seat, index) => {
    if (isOccupiedSeat(seat, index)) return seat;
    const previous = existingPlayers[index];
    if (!isOccupiedSeat(previous, index)) return seat;
    return {
      ...seat,
      name: previous.name || seat?.name,
      avatar: previous.avatar || seat?.avatar,
      cover: previous.cover || seat?.cover,
      profileId: previous.profileId || seat?.profileId,
      isBot: Boolean(previous.isBot),
      isActive: true,
      isOffline: false,
      offlineSince: undefined,
    };
  });
};

const pruneGameIfEmpty = (io, gameId) => {
  if (!gameId) return false;
  const game = games.get(gameId);
  if (!game) return false;

  const onlineCount =
    game.onlinePlayers instanceof Set ? game.onlinePlayers.size : 0;
  const offlineCount =
    game.offlinePlayers instanceof Map ? game.offlinePlayers.size : 0;

  if (onlineCount > 0 || offlineCount > 0) {
    return false;
  }

  clearAllInvitesForGame(io, gameId);
  games.delete(gameId);

  try {
    io.to(`ludo_${gameId}`).emit("ludo:game:removed", {
      gameId,
      reason: "empty",
      serverTs: Date.now(),
    });
  } catch (_e) {}

  try {
    debugLogger.ludoEvent("game-pruned", { gameId, onlineCount, offlineCount });
  } catch (_e) {}

  return true;
};

const clearInvitesForGame = (io, profileId, gameId) => {
  const pid = String(profileId || "");
  if (!pid || !gameId) return;
  const list = userInvites.get(pid) || [];
  const filtered = list.filter((i) => String(i.gameId) !== String(gameId));
  if (filtered.length === list.length) return;
  userInvites.set(pid, filtered);
  try {
    io.to(`user_${pid}`).emit("ludo:invites", { invites: filtered });
  } catch (_e) {}
};

const clearAllInvitesForGame = (io, gameId) => {
  if (!gameId) return;
  for (const profileId of userInvites.keys()) {
    clearInvitesForGame(io, profileId, gameId);
  }
};

// Helper function to get next active player (skip empty/offline/inactive seats)
function getNextActivePlayer(gameState, currentPlayerIndex) {
  const players = Array.isArray(gameState?.lastPlayers?.players)
    ? gameState.lastPlayers.players
    : [];
  const configuredCount = Number(gameState?.lastPlayers?.selectedPlayerCount);
  const totalSeats = Math.max(
    1,
    Math.min(4, configuredCount > 0 ? configuredCount : players.length || 4),
  );

  const isSeatActive = (index) => {
    const player = players[index];
    if (!player) return false;
    if (!player.profileId && player.isBot !== true && player.isActive === false)
      return false;
    if (player.isBot) return true;
    const pid = String(player.profileId || "");
    if (!pid) return Boolean(player.isActive !== false);
    if (gameState?.offlinePlayers?.has(pid)) return false;
    if (player.isActive === false) return false;
    return true;
  };

  for (let offset = 1; offset <= totalSeats; offset += 1) {
    const nextIndex = (currentPlayerIndex + offset) % totalSeats;
    if (isSeatActive(nextIndex)) {
      return nextIndex;
    }
  }

  return currentPlayerIndex;
}

// The host client drives bot seats, so it may roll/move on behalf of a bot.
const isAllowedTurnActor = (lastPlayers, by, seatIndex) => {
  const players = Array.isArray(lastPlayers?.players) ? lastPlayers.players : [];
  const current = lastPlayers?.currentPlayer;
  if (typeof current !== "number") return true;
  if (typeof seatIndex === "number" && seatIndex !== current) return false;
  const sender = String(by || "");
  if (!sender) return false;
  const seat = players[current];
  if (seat?.profileId && String(seat.profileId) === sender) return true;
  const hostId = String(players[0]?.profileId || "");
  return Boolean(seat?.isBot && hostId && hostId === sender);
};

function ludoSocket(io, socket, profileId) {
  // Derive profileId from handshake if not provided
  const effectiveProfileId =
    profileId ||
    socket?.handshake?.query?.profile ||
    socket?.handshake?.query?.profileId;
  try {
    socket.on("error", (err) => {});
    socket.on("connect_error", (err) => {});
    socket.on("disconnect", (reason) => {
      // Track offline players
      if (effectiveProfileId) {
        const pid = String(effectiveProfileId);
        // Remove socket from player's socket set
        const sockets = playerSockets.get(pid);
        if (sockets) {
          sockets.delete(socket.id);
          // If no more sockets for this player, mark as offline in all their games
          if (sockets.size === 0) {
            playerSockets.delete(pid);
            // Find all games this player is in and mark them offline
            const touchedGameIds = [];
            games.forEach((game, gameId) => {
              if (game.onlinePlayers.has(pid)) {
                game.onlinePlayers.delete(pid);
                game.offlinePlayers.set(pid, Date.now());
                touchedGameIds.push(gameId);
                // Notify other players in the game
                io.to(`ludo_${gameId}`).emit("ludo:player:offline", {
                  profileId: pid,
                  gameId,
                  timestamp: Date.now(),
                });
              }
            });

            touchedGameIds.forEach((gameId) => {
              pruneGameIfEmpty(io, gameId);
            });
          }
        }
      }
    });
  } catch (_e) {}
  // Join a per-user room so we can DM invites by profile id
  if (effectiveProfileId) {
    try {
      socket.join(`user_${effectiveProfileId}`);
    } catch (_e) {}
    // Suppressed noisy per-user room join log to reduce debug.log volume
    // (was previously logging user-room-joined for every socket connect)
    // Track socket for this player
    const pid = String(effectiveProfileId);
    if (!playerSockets.has(pid)) {
      playerSockets.set(pid, new Set());
    }
    playerSockets.get(pid).add(socket.id);
    // Mark player as online in any games they're in
    games.forEach((game, gameId) => {
      if (game.offlinePlayers.has(pid)) {
        game.offlinePlayers.delete(pid);
        game.onlinePlayers.add(pid);
        // Notify other players in the game
        io.to(`ludo_${gameId}`).emit("ludo:player:online", {
          profileId: pid,
          gameId,
          timestamp: Date.now(),
        });
      }
    });
    // On connect, send any pending invites to this user
    const invites = userInvites.get(pid) || [];
    if (invites.length > 0) {
      socket.emit("ludo:invites", { invites });
    }
  }

  // Rebuild a saved game from MongoDB when it isn't live in memory. Resolves
  // true when the game has a snapshot afterwards.
  const applySavedGameDoc = (gameId, doc) => {
    if (!doc || doc.gameEnded || !doc.gameStarted) return false;
    const pid = String(effectiveProfileId || "");
    const seats = (doc.players || []).map((p) => idString(p.profileId));
    if (pid && !seats.includes(pid)) return false;

    // Another request may have rebuilt it while we were waiting on the DB.
    const current = games.get(gameId);
    if (current?.lastPlayers) return true;

    const snapshot = docToSnapshot(doc);
    const offlinePlayers = new Map();
    seats.forEach((seatPid) => {
      if (isHumanProfileId(seatPid)) offlinePlayers.set(seatPid, Date.now());
    });
    const entry = current || {
      createdAt: new Date(doc.createdAt || Date.now()).getTime(),
      onlinePlayers: new Set(),
      offlinePlayers,
      pendingAccepts: [],
    };
    if (!current) {
      entry.offlinePlayers = offlinePlayers;
    } else {
      offlinePlayers.forEach((ts, seatPid) => {
        if (!entry.onlinePlayers.has(seatPid)) entry.offlinePlayers.set(seatPid, ts);
      });
    }
    entry.lastPlayers = snapshot;
    entry.paused = snapshot.paused
      ? {
          profileId: snapshot.pausedBy?.profileId,
          name: snapshot.pausedBy?.name,
          at: snapshot.pausedAt || Date.now(),
        }
      : null;
    games.set(gameId, entry);
    try {
      debugLogger.ludoEvent("game-restored-from-db", { gameId, paused: snapshot.paused });
    } catch (_e) {}
    return true;
  };

  const hydrateGameFromDB = (gameId) => {
    const live = games.get(gameId);
    if (live?.lastPlayers) return Promise.resolve(true);
    const Model = getLudoGameModel();
    if (!Model) return Promise.resolve(false);
    return Promise.resolve()
      .then(() => Model.findOne({ gameId }).lean())
      .then((doc) => applySavedGameDoc(gameId, doc))
      .catch(() => false);
  };

  // Runs fn once the game is in memory (rebuilding it from the database if
  // needed). Live games run fn synchronously, so event order is unchanged.
  const withGame = (gameId, fn) => {
    if (games.get(gameId)?.lastPlayers) {
      fn();
      return;
    }
    hydrateGameFromDB(gameId).then(fn, fn);
  };

  const rejectWhilePaused = (gameId) => {
    const game = games.get(gameId);
    if (!game?.paused) return false;
    socket.emit("ludo:paused", {
      gameId,
      pausedBy: { profileId: game.paused.profileId, name: game.paused.name },
      pausedAt: game.paused.at,
      serverTs: Date.now(),
    });
    return true;
  };

  const joinRoom = (gameId) => {
    const room = `ludo_${gameId}`;
    socket.join(room);
    if (!games.has(gameId)) {
      games.set(gameId, {
        createdAt: Date.now(),
        onlinePlayers: new Set(),
        offlinePlayers: new Map(), // profileId -> timestamp when went offline
        // Buffer accepts that arrive before the host has written initial lastPlayers
        pendingAccepts: [],
      });
    }
    // Mark player as online
    if (effectiveProfileId) {
      const game = games.get(gameId);
      if (game) {
        const pid = String(effectiveProfileId);
        const wasAway = game.offlinePlayers.has(pid);
        game.onlinePlayers.add(pid);
        game.offlinePlayers.delete(pid);
        // Back from "save & exit" (or a rebuilt saved game): let the others
        // stop skipping this player's turns.
        if (wasAway) {
          io.to(room).emit("ludo:player:online", {
            profileId: pid,
            gameId,
            timestamp: Date.now(),
          });
        }
      }
    }
    return room;
  };

  socket.on("ludo:join", ({ gameId } = {}) => {
    if (!gameId) return;
    withGame(gameId, () => {
      try {
        const preRoom = `ludo_${gameId}`;
        const preSize = io?.sockets?.adapter?.rooms?.get?.(preRoom)?.size || 0;
        debugLogger.ludoEvent("join", {
          socketId: socket?.id,
          gameId,
          effectiveProfileId,
          beforeRoomSize: preSize,
        });
      } catch (_e) {}
      const room = joinRoom(gameId);
      if (effectiveProfileId) {
        clearInvitesForGame(io, effectiveProfileId, gameId);
      }
      try {
        const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
        io.to(room).emit("ludo:joined", {
          gameId,
          profileId: effectiveProfileId,
          roomSize: size,
        });
        debugLogger.ludoEvent("joined-emitted", {
          room,
          roomSize: size,
          forProfile: effectiveProfileId,
        });
      } catch (e) {
        debugLogger.error("[LUDO][server] ludo:joined emit error", {
          message: e?.message,
        });
      }
      // Send latest players snapshot (if any) only to the newly joined socket
      try {
        const g = games.get(gameId);
        if (g && g.lastPlayers) {
          socket.emit("ludo:players", { ...g.lastPlayers, serverTs: Date.now() });
        }
      } catch (_e) {}
  
    });
  });

  socket.on("ludo:roll", (payload) => {
    const { gameId, by } = payload || {};
    if (!gameId) return;
    if (rejectWhilePaused(gameId)) return;

    // Validate that the player is rolling on their turn
    const game = games.get(gameId);
    if (
      game &&
      game.lastPlayers &&
      typeof game.lastPlayers.currentPlayer === "number"
    ) {
      // Only the current seat's owner (or the host acting for a bot seat) may
      // roll, and a roll claiming another seat's turn is dropped: the host
      // trusts that field, so a client out of step must not advance the game.
      const claimedSeat =
        typeof payload?.currentPlayer === "number"
          ? payload.currentPlayer
          : undefined;
      if (!isAllowedTurnActor(game.lastPlayers, by, claimedSeat)) {
        console.log(
          "[LUDO][server] ❌ ludo:roll rejected - wrong player turn",
          {
            socketId: socket?.id,
            gameId,
            by,
            currentPlayer: game.lastPlayers.currentPlayer,
          },
        );
        return;
      }

      // Cache the latest dice value so reconnecting/joining clients do not see stale roll state.
      if (typeof payload?.value === "number") {
        game.lastPlayers = {
          ...game.lastPlayers,
          diceValue: payload.value,
          currentPlayer: game.lastPlayers.currentPlayer,
        };
      }
    }

    try {
      debugLogger.ludoEvent("roll-validated", {
        socketId: socket?.id,
        gameId,
        by: payload?.by,
        value: payload?.value,
        currentPlayer: payload?.currentPlayer,
      });
      if (game?.lastPlayers) {
        debugLogger.ludoState(gameId, game.lastPlayers);
      }
    } catch (_e) {}

    io.to(`ludo_${gameId}`).emit("ludo:roll", {
      ...payload,
      serverTs: Date.now(),
    });
  });

  socket.on("ludo:move", (payload) => {
    const { gameId, by, playerIndex } = payload || {};
    if (!gameId) return;
    if (rejectWhilePaused(gameId)) return;

    // Validate that player is moving on their turn
    const game = games.get(gameId);
    if (
      game &&
      game.lastPlayers &&
      typeof game.lastPlayers.currentPlayer === "number"
    ) {
      // Only the current seat's owner (or the host acting for a bot seat) may move
      if (!isAllowedTurnActor(game.lastPlayers, by, Number(playerIndex))) {
        console.log(
          "[LUDO][server] ❌ ludo:move rejected - wrong player turn",
          {
            socketId: socket?.id,
            gameId,
            by,
            payloadPlayerIndex: playerIndex,
            currentPlayer: game.lastPlayers.currentPlayer,
          },
        );
        return;
      }
    }

    try {
      debugLogger.ludoEvent("move-validated", {
        socketId: socket?.id,
        gameId,
        by: payload?.by,
        playerIndex: payload?.playerIndex,
        fromSteps: payload?.fromSteps,
        toSteps: payload?.toSteps,
        rolled: payload?.rolled,
      });
      if (game?.lastPlayers) {
        debugLogger.ludoState(gameId, game.lastPlayers);
      }
    } catch (_e) {}

    // Do not guess turn/capture results here.
    // The host/client already computes full Ludo rules and publishes the
    // authoritative ludo:players snapshot after the move completes.
    io.to(`ludo_${gameId}`).emit("ludo:move", {
      ...payload,
      serverTs: Date.now(),
    });
  });

  socket.on("ludo:leave", (payload = {}) => {
    const { gameId, profileId: payloadProfileId } = payload || {};
    if (!gameId) return;

    const pid = String(payloadProfileId || effectiveProfileId || "");
    const game = games.get(gameId);
    if (!game) return;

    const hostId = String(game?.lastPlayers?.players?.[0]?.profileId || "");
    const isHostLeaving = Boolean(pid && hostId && pid === hostId);

    if (isHostLeaving) {
      const participantIds = new Set([
        ...Array.from(game.onlinePlayers || []),
        ...Array.from(game.offlinePlayers?.keys?.() || []),
        ...(game.lastPlayers?.players || [])
          .map((player) => String(player?.profileId || ""))
          .filter(Boolean),
      ]);
      participantIds.forEach((participantId) =>
        clearInvitesForGame(io, participantId, gameId),
      );

      try {
        io.to(`ludo_${gameId}`).emit("ludo:game:removed", {
          gameId,
          reason: "host_left",
          serverTs: Date.now(),
        });
      } catch (_e) {}

      games.delete(gameId);
      try {
        socket.leave(`ludo_${gameId}`);
      } catch (_e) {}
      try {
        debugLogger.ludoEvent("host-left", { gameId, profileId: pid });
      } catch (_e) {}
      return;
    }

    if (pid) {
      game.onlinePlayers.delete(pid);
      game.offlinePlayers.delete(pid);
      clearInvitesForGame(io, pid, gameId);
    }

    if (
      game?.lastPlayers?.players &&
      Array.isArray(game.lastPlayers.players) &&
      pid
    ) {
      game.lastPlayers.players = game.lastPlayers.players.map(
        (player, index) => {
          if (!player?.profileId || String(player.profileId) !== pid) {
            return player;
          }

          return {
            ...player,
            profileId: null,
            isActive: false,
            isOffline: false,
            offlineSince: undefined,
            name:
              player?.isBot || index === 0
                ? player.name
                : `Player ${index + 1}`,
          };
        },
      );
    }

    try {
      socket.leave(`ludo_${gameId}`);
    } catch (_e) {}

    try {
      io.to(`ludo_${gameId}`).emit("ludo:player:left", {
        gameId,
        profileId: pid || undefined,
        serverTs: Date.now(),
      });
    } catch (_e) {}

    if (game.lastPlayers && games.has(gameId)) {
      try {
        const enhanced = { ...game.lastPlayers };
        if (Array.isArray(enhanced.players)) {
          enhanced.players = enhanced.players.map((p) => {
            const playerId = String(p?.profileId || "");
            const isOnline = playerId && game.onlinePlayers.has(playerId);
            const isOffline = playerId && game.offlinePlayers.has(playerId);
            return {
              ...p,
              isActive: isOnline || !playerId,
              isOffline,
              offlineSince: isOffline
                ? game.offlinePlayers.get(playerId)
                : undefined,
            };
          });
        }
        bumpPlayersSeq(enhanced);
        game.lastPlayers = enhanced;
        io.to(`ludo_${gameId}`).emit("ludo:players", {
          ...enhanced,
          serverTs: Date.now(),
        });
      } catch (_e) {}
    }

    pruneGameIfEmpty(io, gameId);

    try {
      debugLogger.ludoEvent("leave", {
        gameId,
        profileId: pid || null,
        removed: !games.has(gameId),
      });
    } catch (_e) {}
  });

  // Host sends an invite specifying target connect profile id
  socket.on("ludo:invite", (payload = {}) => {
    const { to, gameId } = payload;
    if (!to) {
      return;
    }
    try {
      debugLogger.ludoEvent("invite-received", {
        socketId: socket?.id,
        to,
        by: payload?.by,
        gameId: payload?.gameId,
        slotIndex: payload?.slotIndex,
        playerCount: payload?.playerCount,
      });
    } catch (_e) {}

    const targetId = String(to);
    const existingGame = gameId ? games.get(gameId) : null;
    const isReinvite = payload.reinvite === true;
    const alreadyJoined = Boolean(
      gameId &&
      (existingGame?.onlinePlayers?.has(targetId) ||
        existingGame?.offlinePlayers?.has(targetId) ||
        existingGame?.lastPlayers?.players?.some?.(
          (p) => p?.profileId && String(p.profileId) === targetId,
        )),
    );

    if (alreadyJoined && !isReinvite) {
      clearInvitesForGame(io, targetId, gameId);
      return;
    }

    const invite = {
      ...payload,
      reinvite: isReinvite,
      inviteId:
        payload.inviteId ||
        `${String(gameId || "game")}:${targetId}:${Date.now()}`,
      ts: Date.now(),
    };
    const list = userInvites.get(targetId) || [];
    // Deduplicate by gameId+by
    const existingIndex = list.findIndex(
      (i) =>
        String(i.gameId) === String(invite.gameId) &&
        String(i.by) === String(invite.by),
    );
    if (existingIndex >= 0) {
      list[existingIndex] = invite;
    } else {
      list.push(invite);
    }
    userInvites.set(targetId, list);
    // Notify target user: single invite + full list snapshot
    try {
      const room = `user_${to}`;
      const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
      debugLogger.ludoEvent("invite-emitted", {
        room,
        invitesCount: list.length,
        targetSockets: size,
      });
    } catch (_e) {}
    io.to(`user_${to}`).emit("ludo:invite", {
      ...invite,
      serverTs: Date.now(),
    });
    io.to(`user_${to}`).emit("ludo:invites", { invites: list });
  });

  // Invitee accepted; notify the room that they joined a specific slot
  socket.on("ludo:accept", (payload = {}) => {
    const { gameId } = payload;
    if (!gameId) return;
    const pid = String(effectiveProfileId || "");
    if (!pid) return;

    try {
      const room = `ludo_${gameId}`;
      const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
      debugLogger.ludoEvent("accept", {
        socketId: socket?.id,
        effectiveProfileId,
        payload,
        room,
        roomSize: size,
      });
    } catch (_e) {}

    const room = joinRoom(gameId);
    const game = games.get(gameId);

    // If host hasn't published initial lastPlayers yet, buffer this accept
    // so it can be merged into the first ludo:players snapshot received.
    if (!game?.lastPlayers) {
      try {
        game.pendingAccepts = game.pendingAccepts || [];
        game.pendingAccepts.push({ payload, pid, ts: Date.now() });
      } catch (_e) {}

      // Still notify the room that the accept occurred (UI may optimistically transition)
      try {
        const emitted = {
          ...payload,
          slotIndex: payload?.slotIndex,
          connect: {
            ...payload?.connect,
            _id: pid,
          },
          serverTs: Date.now(),
        };
        io.to(room).emit("ludo:accepted", emitted);
        const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
        debugLogger.ludoEvent("accepted-emitted", {
          room,
          roomSize: size,
          payload: emitted,
        });
      } catch (e) {
        debugLogger.error("[LUDO][server] ludo:accepted emit error", {
          message: e?.message,
        });
      }

      // Remove this invite from the user's pending list and return; the actual
      // players merge will happen when the host posts ludo:players.
      if (pid) {
        clearInvitesForGame(io, pid, payload.gameId);
      }
      return;
    }

    const requestedSlot = Number(payload?.slotIndex);
    let acceptedSlot = Number.isInteger(requestedSlot) ? requestedSlot : -1;

    if (game?.lastPlayers?.players && Array.isArray(game.lastPlayers.players)) {
      const players = game.lastPlayers.players;
      const alreadyInGameIndex = players.findIndex(
        (player) => player?.profileId && String(player.profileId) === pid,
      );

      if (alreadyInGameIndex >= 0) {
        acceptedSlot = alreadyInGameIndex;
        game.lastPlayers.players[acceptedSlot] = {
          ...players[acceptedSlot],
          name: payload?.connect?.fullName || players[acceptedSlot].name,
          avatar: payload?.connect?.profilePic || players[acceptedSlot].avatar,
          cover:
            payload?.connect?.coverPic ||
            payload?.connect?.cover ||
            players[acceptedSlot].cover,
          isActive: true,
          isOffline: false,
          offlineSince: undefined,
        };
      } else if (
        acceptedSlot >= 0 &&
        players[acceptedSlot] &&
        !players[acceptedSlot].profileId &&
        !players[acceptedSlot].isBot
      ) {
        game.lastPlayers.players[acceptedSlot] = {
          ...players[acceptedSlot],
          name: payload?.connect?.fullName || players[acceptedSlot].name,
          avatar: payload?.connect?.profilePic || players[acceptedSlot].avatar,
          cover:
            payload?.connect?.coverPic ||
            payload?.connect?.cover ||
            players[acceptedSlot].cover,
          profileId: pid,
          isActive: true,
          isOffline: false,
          offlineSince: undefined,
        };
      } else {
        const fallbackSlot = players.findIndex((player, index) => {
          if (index === 0) return false;
          return player && !player.profileId && !player.isBot;
        });

        if (fallbackSlot >= 0) {
          acceptedSlot = fallbackSlot;
          game.lastPlayers.players[acceptedSlot] = {
            ...players[acceptedSlot],
            name: payload?.connect?.fullName || players[acceptedSlot].name,
            avatar: payload?.connect?.profilePic || players[acceptedSlot].avatar,
            cover:
              payload?.connect?.coverPic ||
              payload?.connect?.cover ||
              players[acceptedSlot].cover,
            profileId: pid,
            isActive: true,
            isOffline: false,
            offlineSince: undefined,
          };
        }
      }
    }

    try {
      const emitted = {
        ...payload,
        slotIndex: acceptedSlot >= 0 ? acceptedSlot : payload?.slotIndex,
        connect: {
          ...payload?.connect,
          _id: pid,
        },
        serverTs: Date.now(),
      };
      io.to(room).emit("ludo:accepted", emitted);
      const size = io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0;
      debugLogger.ludoEvent("accepted-emitted", {
        room,
        roomSize: size,
        payload: emitted,
      });

      if (game?.lastPlayers) {
        bumpPlayersSeq(game.lastPlayers);
        debugLogger.ludoState(gameId, game.lastPlayers);
        io.to(room).emit("ludo:players", {
          ...game.lastPlayers,
          serverTs: Date.now(),
        });
      }
    } catch (e) {
      debugLogger.error("[LUDO][server] ludo:accepted emit error", {
        message: e?.message,
      });
    }
    // Remove this invite from the user's pending list
    if (pid) {
      clearInvitesForGame(io, pid, payload.gameId);
      try {
        const g = games.get(gameId);
        if (g?.lastPlayers?.players) {
          g.lastPlayers.players.forEach((player) => {
            const playerId = String(player?.profileId || "");
            if (playerId) {
              clearInvitesForGame(io, playerId, gameId);
            }
          });
        }
      } catch (_e) {}
    }
  });

  // Broadcast players/state snapshot so all clients sync
  socket.on("ludo:players", (payload = {}) => {
    const { gameId } = payload;
    if (!gameId) return;
    // cache latest snapshot for late joiners
    const existing = games.get(gameId) || {
      createdAt: Date.now(),
      onlinePlayers: new Set(),
      offlinePlayers: new Map(),
    };
    // Enhance payload with online/offline status
    const enhancedPayload = { ...payload };
    if (Array.isArray(payload.players)) {
      enhancedPayload.players = payload.players.map((p) => {
        const pid = String(p.profileId || "");
        const isOnline = pid && existing.onlinePlayers.has(pid);
        const isOffline = pid && existing.offlinePlayers.has(pid);
        return {
          ...p,
          isActive: isOnline || !pid, // Bots (no profileId) are always active
          isOffline: isOffline,
          offlineSince: isOffline
            ? existing.offlinePlayers.get(pid)
            : undefined,
        };
      });

      // If any accepts were buffered because host had not yet published
      // lastPlayers, merge them into this incoming payload so late-joiners
      // and slot assignments are applied deterministically.
      if (
        existing?.pendingAccepts &&
        Array.isArray(existing.pendingAccepts) &&
        existing.pendingAccepts.length > 0
      ) {
        try {
          enhancedPayload.players = enhancedPayload.players || [];
          existing.pendingAccepts.forEach((pa) => {
            const pending = pa?.payload || {};
            const pPid = pa?.pid || (pending?.by && String(pending.by));
            if (!pPid) return;

            const playersArr = enhancedPayload.players;
            const requestedSlot = Number(pending?.slotIndex);
            let assignedSlot = Number.isInteger(requestedSlot)
              ? requestedSlot
              : -1;

            const alreadyInGameIndex = playersArr.findIndex(
              (pl) => pl?.profileId && String(pl.profileId) === String(pPid),
            );
            if (alreadyInGameIndex >= 0) {
              assignedSlot = alreadyInGameIndex;
            } else if (
              assignedSlot >= 0 &&
              playersArr[assignedSlot] &&
              !playersArr[assignedSlot].profileId &&
              !playersArr[assignedSlot].isBot
            ) {
              playersArr[assignedSlot] = {
                ...playersArr[assignedSlot],
                name:
                  pending?.connect?.fullName || playersArr[assignedSlot].name,
                avatar:
                  pending?.connect?.profilePic ||
                  playersArr[assignedSlot].avatar,
                cover:
                  pending?.connect?.coverPic ||
                  pending?.connect?.cover ||
                  playersArr[assignedSlot].cover,
                profileId: pPid,
                isActive: true,
                isOffline: false,
                offlineSince: undefined,
              };
            } else {
              const fallback = playersArr.findIndex((player, idx) =>
                idx === 0
                  ? false
                  : player && !player.profileId && !player.isBot,
              );
              if (fallback >= 0) {
                assignedSlot = fallback;
                playersArr[assignedSlot] = {
                  ...playersArr[assignedSlot],
                  name:
                    pending?.connect?.fullName || playersArr[assignedSlot].name,
                  avatar:
                    pending?.connect?.profilePic ||
                    playersArr[assignedSlot].avatar,
                  cover:
                    pending?.connect?.coverPic ||
                    pending?.connect?.cover ||
                    playersArr[assignedSlot].cover,
                  profileId: pPid,
                  isActive: true,
                  isOffline: false,
                  offlineSince: undefined,
                };
              }
            }
          });

          // Drain buffer after merging
          existing.pendingAccepts = [];
        } catch (_e) {}
      }
    }
    if (
      existing?.lastPlayers?.players &&
      Array.isArray(enhancedPayload.players) &&
      !enhancedPayload.gameStarted
    ) {
      const incomingOccupied = countOccupiedSeats(enhancedPayload.players);
      const existingOccupied = countOccupiedSeats(existing.lastPlayers.players);
      if (incomingOccupied < existingOccupied) {
        enhancedPayload.players = mergeLobbyOccupants(
          enhancedPayload.players,
          existing.lastPlayers.players,
        );
        bumpPlayersSeq(enhancedPayload);
      }
    }
    if (existing?.lastPlayers) {
      const prevSeq = Math.max(
        Number(existing.lastPlayers.playersSeq || 0),
        Number(existing.lastPlayers.stateVersion || 0),
        0,
      );
      // Keep versions strictly increasing so clients never drop a fresh
      // snapshot as a duplicate of the previous one.
      const incomingSeq = Math.max(
        Number(enhancedPayload.playersSeq || 0),
        Number(enhancedPayload.stateVersion || 0),
      );
      const nextSeq = incomingSeq > prevSeq ? incomingSeq : prevSeq + 1;
      enhancedPayload.playersSeq = nextSeq;
      enhancedPayload.stateVersion = nextSeq;
    }
    // Only ludo:resume clears a pause; a snapshot sent before the host saw
    // the pause must not silently unpause the match.
    if (existing?.paused) {
      enhancedPayload.paused = true;
      enhancedPayload.pausedAt = existing.paused.at;
      enhancedPayload.pausedBy = {
        profileId: existing.paused.profileId,
        name: existing.paused.name,
      };
    } else {
      enhancedPayload.paused = false;
      delete enhancedPayload.pausedAt;
      delete enhancedPayload.pausedBy;
    }
    games.set(gameId, { ...existing, lastPlayers: enhancedPayload });
    try {
      debugLogger.ludoEvent("players-snapshot", {
        gameId,
        players: Array.isArray(payload?.players)
          ? payload.players.length
          : "n/a",
        selectedPlayerCount: payload?.selectedPlayerCount,
        currentPlayer: payload?.currentPlayer,
      });
      debugLogger.ludoState(gameId, enhancedPayload);
    } catch (_e) {}
    io.to(`ludo_${gameId}`).emit("ludo:players", {
      ...enhancedPayload,
      serverTs: Date.now(),
    });
  });

  // Client requests all games they've joined
  socket.on("ludo:games:get", () => {
    const pid = String(effectiveProfileId || "");
    if (!pid) return;

    const userGames = [];
    const listedIds = new Set();
    games.forEach((game, gameId) => {
      // Check if user is in this game (online or offline)
      if (game.onlinePlayers.has(pid) || game.offlinePlayers.has(pid)) {
        userGames.push({
          gameId,
          createdAt: game.createdAt,
          onlinePlayers: Array.from(game.onlinePlayers),
          offlinePlayers: Array.from(game.offlinePlayers.keys()),
          lastPlayers: game.lastPlayers,
          isOnline: game.onlinePlayers.has(pid),
          playerCount: game.onlinePlayers.size + game.offlinePlayers.size,
          paused: Boolean(game.paused),
        });
        listedIds.add(String(gameId));
      }
    });

    // Saved matches that are not live right now (server restarted, or every
    // player left the board) are still resumable.
    const addSavedGames = (saved = []) => {
      saved.forEach((doc) => {
          if (listedIds.has(String(doc.gameId))) return;
          const snapshot = docToSnapshot(doc);
          userGames.push({
            gameId: doc.gameId,
            createdAt: new Date(doc.createdAt || Date.now()).getTime(),
            onlinePlayers: [],
            offlinePlayers: [],
            lastPlayers: snapshot,
            isOnline: false,
            playerCount: snapshot.players.filter(
              (p, index) => isOccupiedSeat(p, index),
            ).length,
            paused: Boolean(doc.paused),
            saved: true,
            lastUpdated: doc.lastUpdated,
          });
        });
    };

    const sendGames = () => {
      try {
        debugLogger.ludoEvent("games-get", {
          pid,
          gamesCount: userGames.length,
        });
      } catch (_e) {}
      socket.emit("ludo:games", { games: userGames });
    };

    const Model = getLudoGameModel();
    if (!Model || !isObjectId(pid)) {
      sendGames();
      return;
    }
    Promise.resolve()
      .then(() =>
        Model.find({
          "players.profileId": pid,
          gameEnded: false,
          gameStarted: true,
          lastUpdated: { $gte: new Date(Date.now() - SAVED_GAME_MAX_AGE_MS) },
        })
          .sort({ lastUpdated: -1 })
          .limit(20)
          .lean(),
      )
      .then(addSavedGames)
      .catch(() => {})
      .then(sendGames);
  });

  // Client requests full pending invites list
  socket.on("ludo:invites:get", () => {
    const pid = String(effectiveProfileId || "");
    if (!pid) return;
    const invites = userInvites.get(pid) || [];
    // Suppressed noisy invites-get debug event; emit invites only
    socket.emit("ludo:invites", { invites });
  });

  // Client requests latest players snapshot for a specific game
  socket.on("ludo:players:get", (payload = {}) => {
    const { gameId } = payload || {};
    if (!gameId) return;
    withGame(gameId, () => {
      try {
        const g = games.get(gameId);
        if (g && g.lastPlayers) {
          // Enhance with current online/offline status
          const enhanced = { ...g.lastPlayers };
          if (Array.isArray(enhanced.players)) {
            enhanced.players = enhanced.players.map((p) => {
              const pid = String(p.profileId || "");
              const isOnline = pid && g.onlinePlayers.has(pid);
              const isOffline = pid && g.offlinePlayers.has(pid);
              return {
                ...p,
                isActive: isOnline || !pid,
                isOffline: isOffline,
                offlineSince: isOffline ? g.offlinePlayers.get(pid) : undefined,
              };
            });
          }
          debugLogger.ludoEvent("players-get-response", { gameId });
          debugLogger.ludoState(gameId, enhanced);
          socket.emit("ludo:players", { ...enhanced, serverTs: Date.now() });
        }
      } catch (_e) {}
  
    });
  });

  // Only the host may replace a non-host seat with a computer player.
  socket.on("ludo:replace:bot", (payload = {}) => {
    const { gameId, playerIndex } = payload || {};
    if (!gameId || typeof playerIndex !== "number" || playerIndex <= 0) return;
    try {
      const g = games.get(gameId);
      if (!g?.lastPlayers || !Array.isArray(g.lastPlayers.players)) return;

      const requesterId = String(effectiveProfileId || "");
      const hostId = String(g.lastPlayers.players[0]?.profileId || "");
      if (!requesterId || !hostId || requesterId !== hostId) return;

      const player = g.lastPlayers.players[playerIndex];
      if (!player || player.isBot) return;

      const replacedProfileId = String(player.profileId || "");
      if (replacedProfileId) {
        g.offlinePlayers.delete(replacedProfileId);
        g.onlinePlayers.delete(replacedProfileId);
        clearInvitesForGame(io, replacedProfileId, gameId);
      }

      g.lastPlayers.players[playerIndex] = {
        ...player,
        name: `Computer ${playerIndex}`,
        avatar: null,
        cover: null,
        profileId: null,
        isActive: true,
        isOffline: false,
        offlineSince: undefined,
        isBot: true,
      };
      g.lastPlayers.lastActionType = "player_replace_bot";
      g.lastPlayers.timestamp = Date.now();
      bumpPlayersSeq(g.lastPlayers);

      io.to(`ludo_${gameId}`).emit("ludo:players", {
        ...g.lastPlayers,
        serverTs: Date.now(),
      });
      debugLogger.ludoEvent("replace-bot", {
        gameId,
        playerIndex,
        replacedProfileId,
      });
      debugLogger.ludoState(gameId, g.lastPlayers);
    } catch (_e) {}
  });

  // Host requests to remove offline player
  socket.on("ludo:remove:player", (payload = {}) => {
    const { gameId, playerIndex } = payload || {};
    if (!gameId || typeof playerIndex !== "number") return;
    try {
      const g = games.get(gameId);
      if (g && g.lastPlayers && Array.isArray(g.lastPlayers.players)) {
        // Only the host may remove a seat.
        const requesterId = String(effectiveProfileId || "");
        const hostId = String(g.lastPlayers.players[0]?.profileId || "");
        if (!requesterId || requesterId !== hostId || playerIndex <= 0) return;
        const player = g.lastPlayers.players[playerIndex];
        if (player && player.profileId) {
          // Remove from tracking
          const pid = String(player.profileId);
          g.offlinePlayers.delete(pid);
          g.onlinePlayers.delete(pid);
          // Clear the slot
          g.lastPlayers.players[playerIndex] = {
            ...player,
            profileId: null,
            name: `Player ${playerIndex + 1}`,
            isActive: false,
          };
          bumpPlayersSeq(g.lastPlayers);
          // Broadcast update
          io.to(`ludo_${gameId}`).emit("ludo:players", {
            ...g.lastPlayers,
            serverTs: Date.now(),
          });
          debugLogger.ludoEvent("remove-player", {
            gameId,
            playerIndex,
          });
          debugLogger.ludoState(gameId, g.lastPlayers);
        }
      }
    } catch (_e) {}
  });

  // Round-trip probe so clients can show "reconnecting" on a slow connection,
  // not only after socket.io's own (much slower) heartbeat gives up.
  // Any human player may pause; the match (and every seat) is kept, saved,
  // and play is blocked until the host resumes it.
  socket.on("ludo:pause", (payload = {}) => {
    const { gameId } = payload || {};
    const pid = String(effectiveProfileId || "");
    if (!gameId || !pid) return;
    withGame(gameId, () => {
      const game = games.get(gameId);
      const players = game?.lastPlayers?.players || [];
      const seat = players.find((p) => String(p?.profileId || "") === pid);
      if (!game || !seat || game.lastPlayers.gameEnded) return;

      if (!game.paused) {
        game.paused = {
          profileId: pid,
          name: String(payload.name || seat.name || "A player"),
          at: Date.now(),
        };
        game.lastPlayers = bumpPlayersSeq({
          ...game.lastPlayers,
          paused: true,
          pausedAt: game.paused.at,
          pausedBy: { profileId: pid, name: game.paused.name },
        });
        persistPauseState(gameId, game.paused);
        try {
          debugLogger.ludoEvent("game-paused", { gameId, by: pid });
        } catch (_e) {}
      }

      const event = {
        gameId,
        pausedBy: { profileId: game.paused.profileId, name: game.paused.name },
        pausedAt: game.paused.at,
        serverTs: Date.now(),
      };
      io.to(`ludo_${gameId}`).emit("ludo:paused", event);
      socket.emit("ludo:paused", event);
      io.to(`ludo_${gameId}`).emit("ludo:players", {
        ...game.lastPlayers,
        serverTs: Date.now(),
      });
  
    });
  });

  // Only the host resumes, because the host's client runs the turn logic
  // (and any computer seats) that the match needs to continue.
  socket.on("ludo:resume", (payload = {}) => {
    const { gameId } = payload || {};
    const pid = String(effectiveProfileId || "");
    if (!gameId || !pid) return;
    withGame(gameId, () => {
      const game = games.get(gameId);
      if (!game?.lastPlayers) return;
      const hostId = String(game.lastPlayers.players?.[0]?.profileId || "");
      if (!hostId || hostId !== pid) {
        socket.emit("ludo:resume:denied", {
          gameId,
          reason: "host_only",
          serverTs: Date.now(),
        });
        return;
      }

      if (game.paused) {
        game.paused = null;
        const next = { ...game.lastPlayers, paused: false };
        delete next.pausedAt;
        delete next.pausedBy;
        game.lastPlayers = bumpPlayersSeq(next);
        persistPauseState(gameId, null);
        try {
          debugLogger.ludoEvent("game-resumed", { gameId, by: pid });
        } catch (_e) {}
      }

      io.to(`ludo_${gameId}`).emit("ludo:resumed", {
        gameId,
        by: pid,
        serverTs: Date.now(),
      });
      socket.emit("ludo:resumed", { gameId, by: pid, serverTs: Date.now() });
      io.to(`ludo_${gameId}`).emit("ludo:players", {
        ...game.lastPlayers,
        serverTs: Date.now(),
      });
  
    });
  });

  // A player closed the board but kept their seat (saved for later). Treat
  // them like a disconnected player so turns don't wait for them, and stop
  // sending them this room's events. ludo:join brings them back online.
  socket.on("ludo:board:closed", (payload = {}) => {
    const { gameId } = payload || {};
    const pid = String(effectiveProfileId || "");
    if (!gameId || !pid) return;
    try {
      socket.leave(`ludo_${gameId}`);
    } catch (_e) {}
    const game = games.get(gameId);
    if (!game) return;
    if (game.onlinePlayers.has(pid)) {
      game.onlinePlayers.delete(pid);
      game.offlinePlayers.set(pid, Date.now());
      io.to(`ludo_${gameId}`).emit("ludo:player:offline", {
        profileId: pid,
        gameId,
        timestamp: Date.now(),
      });
    }
  });

  socket.on("ludo:ping", (_payload, ack) => {
    if (typeof ack === "function") ack({ serverTs: Date.now() });
  });

  // Client dismisses an invite without accepting
  socket.on("ludo:invites:dismiss", (payload = {}) => {
    const pid = String(effectiveProfileId || "");
    if (!pid) return;
    const { gameId, by } = payload;
    if (!gameId) return;
    const list = userInvites.get(pid) || [];
    const filtered = list.filter(
      (i) =>
        !(
          String(i.gameId) === String(gameId) &&
          (by ? String(i.by) === String(by) : true)
        ),
    );
    userInvites.set(pid, filtered);
    try {
      debugLogger.ludoEvent("invites-dismissed", {
        pid,
        gameId,
        by,
        before: list.length,
        after: filtered.length,
      });
    } catch (_e) {}
    io.to(`user_${pid}`).emit("ludo:invites", { invites: filtered });
  });
}

module.exports = ludoSocket;
