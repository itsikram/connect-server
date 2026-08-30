// Minimal Ludo game socket relay for online play and device migration

const { debugLogger } = require("../utils/debugLogger");

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
        game.onlinePlayers.add(String(effectiveProfileId));
        game.offlinePlayers.delete(String(effectiveProfileId));
      }
    }
    return room;
  };

  socket.on("ludo:join", ({ gameId }) => {
    if (!gameId) return;
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

  socket.on("ludo:roll", (payload) => {
    const { gameId, by } = payload || {};
    if (!gameId) return;

    // Validate that the player is rolling on their turn
    const game = games.get(gameId);
    if (
      game &&
      game.lastPlayers &&
      typeof game.lastPlayers.currentPlayer === "number"
    ) {
      // Find the player index for this profileId
      const playerIndex = game.lastPlayers.players?.findIndex(
        (p) => p.profileId && String(p.profileId) === String(by),
      );

      // Only allow roll if this player is the current player
      if (playerIndex !== game.lastPlayers.currentPlayer) {
        console.log(
          "[LUDO][server] ❌ ludo:roll rejected - wrong player turn",
          {
            socketId: socket?.id,
            gameId,
            by,
            playerIndex,
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

    // Validate that player is moving on their turn
    const game = games.get(gameId);
    if (
      game &&
      game.lastPlayers &&
      typeof game.lastPlayers.currentPlayer === "number"
    ) {
      // Find player index for this profileId
      const senderPlayerIndex = game.lastPlayers.players?.findIndex(
        (p) => p.profileId && String(p.profileId) === String(by),
      );

      // Only allow move if this player is current player and matches playerIndex in payload
      if (
        senderPlayerIndex !== game.lastPlayers.currentPlayer ||
        senderPlayerIndex !== playerIndex
      ) {
        console.log(
          "[LUDO][server] ❌ ludo:move rejected - wrong player turn",
          {
            socketId: socket?.id,
            gameId,
            by,
            senderPlayerIndex,
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

  // Host sends an invite specifying target friend profile id
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

    // A delayed invite acceptance must not reclaim a seat after the host has
    // replaced waiting players and started the match.
    if (game?.lastPlayers?.gameStarted) {
      game.onlinePlayers.delete(pid);
      game.offlinePlayers.delete(pid);
      clearInvitesForGame(io, pid, gameId);
      try {
        socket.leave(room);
        socket.emit("ludo:game:removed", {
          gameId,
          reason: "game_already_started",
          serverTs: Date.now(),
        });
      } catch (_e) {}
      return;
    }

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
          friend: {
            ...payload?.friend,
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
          name: payload?.friend?.fullName || players[acceptedSlot].name,
          avatar: payload?.friend?.profilePic || players[acceptedSlot].avatar,
          cover:
            payload?.friend?.coverPic ||
            payload?.friend?.cover ||
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
          name: payload?.friend?.fullName || players[acceptedSlot].name,
          avatar: payload?.friend?.profilePic || players[acceptedSlot].avatar,
          cover:
            payload?.friend?.coverPic ||
            payload?.friend?.cover ||
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
            name: payload?.friend?.fullName || players[acceptedSlot].name,
            avatar: payload?.friend?.profilePic || players[acceptedSlot].avatar,
            cover:
              payload?.friend?.coverPic ||
              payload?.friend?.cover ||
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
        friend: {
          ...payload?.friend,
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
                  pending?.friend?.fullName || playersArr[assignedSlot].name,
                avatar:
                  pending?.friend?.profilePic ||
                  playersArr[assignedSlot].avatar,
                cover:
                  pending?.friend?.coverPic ||
                  pending?.friend?.cover ||
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
                    pending?.friend?.fullName || playersArr[assignedSlot].name,
                  avatar:
                    pending?.friend?.profilePic ||
                    playersArr[assignedSlot].avatar,
                  cover:
                    pending?.friend?.coverPic ||
                    pending?.friend?.cover ||
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
      const nextSeq = Math.max(
        Number(enhancedPayload.playersSeq || 0),
        Number(enhancedPayload.stateVersion || 0),
        prevSeq,
      );
      enhancedPayload.playersSeq = nextSeq;
      enhancedPayload.stateVersion = nextSeq;
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
        });
      }
    });

    try {
      debugLogger.ludoEvent("games-get", {
        pid,
        gamesCount: userGames.length,
      });
    } catch (_e) {}

    socket.emit("ludo:games", { games: userGames });
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
