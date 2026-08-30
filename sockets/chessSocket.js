// Chess game socket handler for online multiplayer and friend invites

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const games = new Map(); // gameId -> game snapshot
const userInvites = new Map(); // profileId -> [{ gameId, by, name, avatar, ts }]
const playerSockets = new Map(); // profileId -> Set<socketId>

const publicGameState = (gameId, game) => ({
  gameId,
  fen: game?.fen || STARTING_FEN,
  whitePlayer: game?.whitePlayer || null,
  blackPlayer: game?.blackPlayer || null,
  whitePlayerInfo: game?.whitePlayerInfo || null,
  blackPlayerInfo: game?.blackPlayerInfo || null,
  lastMove: game?.lastMove || null,
  serverTs: Date.now(),
});

const attachPlayerInfo = (game, profileId, info = {}) => {
  if (!game || !profileId) return;
  const pid = String(profileId);
  const nextInfo = {
    profileId: pid,
    name: info.name || info.fullName || "",
    avatar: info.avatar || info.profilePic || "",
  };
  if (game.whitePlayer === pid) {
    game.whitePlayerInfo = { ...game.whitePlayerInfo, ...nextInfo };
  }
  if (game.blackPlayer === pid) {
    game.blackPlayerInfo = { ...game.blackPlayerInfo, ...nextInfo };
  }
};

const ensureGame = (gameId) => {
  if (!games.has(gameId)) {
    games.set(gameId, {
      createdAt: Date.now(),
      fen: STARTING_FEN,
      whitePlayer: null,
      blackPlayer: null,
      whitePlayerInfo: null,
      blackPlayerInfo: null,
      onlinePlayers: new Set(),
      offlinePlayers: new Map(),
      lastMove: null,
    });
  }
  return games.get(gameId);
};

function chessSocket(io, socket, profileId) {
  const effectiveProfileId =
    profileId ||
    socket?.handshake?.query?.profile ||
    socket?.handshake?.query?.profileId;

  try {
    socket.on("error", (err) => {
      try {
        console.error("[CHESS][server] socket error", {
          socketId: socket?.id,
          message: err?.message,
        });
      } catch (_e2) {}
    });

    socket.on("connect_error", (err) => {
      try {
        console.error("[CHESS][server] connect_error", {
          socketId: socket?.id,
          message: err?.message,
        });
      } catch (_e2) {}
    });

    socket.on("disconnect", (reason) => {
      try {
        console.log("[CHESS][server] disconnect", {
          socketId: socket?.id,
          reason,
        });
      } catch (_e2) {}

      if (effectiveProfileId) {
        const pid = String(effectiveProfileId);
        const sockets = playerSockets.get(pid);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            playerSockets.delete(pid);
            games.forEach((game, gameId) => {
              if (game.onlinePlayers.has(pid)) {
                game.onlinePlayers.delete(pid);
                game.offlinePlayers.set(pid, Date.now());
                io.to(`chess_${gameId}`).emit("chess:player:offline", {
                  profileId: pid,
                  gameId,
                  timestamp: Date.now(),
                });
              }
            });
          }
        }
      }
    });
  } catch (_e) {}

  if (effectiveProfileId) {
    try {
      socket.join(`user_${effectiveProfileId}`);
    } catch (_e) {}

    const pid = String(effectiveProfileId);
    if (!playerSockets.has(pid)) {
      playerSockets.set(pid, new Set());
    }
    playerSockets.get(pid).add(socket.id);

    games.forEach((game, gameId) => {
      if (game.offlinePlayers.has(pid)) {
        game.offlinePlayers.delete(pid);
        game.onlinePlayers.add(pid);
        io.to(`chess_${gameId}`).emit("chess:player:online", {
          profileId: pid,
          gameId,
          timestamp: Date.now(),
        });
      }
    });

    const invites = userInvites.get(pid) || [];
    if (invites.length > 0) {
      socket.emit("chess:invites", { invites });
    }
  }

  const joinRoom = (gameId) => {
    const room = `chess_${gameId}`;
    socket.join(room);
    const game = ensureGame(gameId);

    if (effectiveProfileId) {
      game.onlinePlayers.add(String(effectiveProfileId));
      game.offlinePlayers.delete(String(effectiveProfileId));
    }

    return { room, game };
  };

  const assignSeat = (game, pid, info = {}) => {
    if (!game || !pid) return;
    if (game.whitePlayer === pid || game.blackPlayer === pid) {
      attachPlayerInfo(game, pid, info);
      return;
    }
    if (!game.whitePlayer) {
      game.whitePlayer = pid;
      attachPlayerInfo(game, pid, info);
      return;
    }
    if (game.whitePlayer !== pid && !game.blackPlayer) {
      game.blackPlayer = pid;
      attachPlayerInfo(game, pid, info);
    }
  };

  const emitState = (gameId) => {
    const game = games.get(gameId);
    if (!game) return;
    io.to(`chess_${gameId}`).emit("chess:state", publicGameState(gameId, game));
  };

  socket.on("chess:join", (payload = {}) => {
    const { gameId, name, avatar } = payload;
    if (!gameId) return;

    const { room, game } = joinRoom(gameId);
    const roomSize = io?.sockets?.adapter?.rooms?.get(room)?.size || 0;
    const pid = effectiveProfileId ? String(effectiveProfileId) : null;

    if (game && pid) {
      assignSeat(game, pid, { name, avatar });
    }

    io.to(room).emit("chess:joined", {
      gameId,
      profileId: effectiveProfileId,
      roomSize,
    });
    emitState(gameId);
  });

  socket.on("chess:create", (payload = {}) => {
    const { gameId, name, avatar } = payload;
    if (!gameId) return;

    const { game } = joinRoom(gameId);
    if (game && effectiveProfileId) {
      const pid = String(effectiveProfileId);
      if (!game.whitePlayer) {
        game.whitePlayer = pid;
      }
      attachPlayerInfo(game, pid, { name, avatar });
      emitState(gameId);
    }
  });

  socket.on("chess:move", (payload) => {
    const { gameId, move } = payload || {};
    if (!gameId || !move) return;

    const game = games.get(gameId);
    if (!game) return;

    game.fen = move.fen;
    game.lastMove = {
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      timestamp: Date.now(),
    };

    io.to(`chess_${gameId}`).emit("chess:move", {
      ...payload,
      serverTs: Date.now(),
    });
  });

  socket.on("chess:state", (payload) => {
    const { gameId, fen, whitePlayer, blackPlayer } = payload || {};
    if (!gameId) return;

    const game = ensureGame(gameId);
    if (fen) game.fen = fen;
    if (whitePlayer) game.whitePlayer = String(whitePlayer);
    if (blackPlayer) game.blackPlayer = String(blackPlayer);

    emitState(gameId);
  });

  socket.on("chess:assign", (payload) => {
    const { gameId, profileId: assignProfileId, color, name, avatar } =
      payload || {};
    if (!gameId || !assignProfileId || !color) return;

    const game = games.get(gameId);
    if (!game) return;

    if (color === "white") {
      game.whitePlayer = String(assignProfileId);
    } else if (color === "black") {
      game.blackPlayer = String(assignProfileId);
    }
    attachPlayerInfo(game, assignProfileId, { name, avatar });
    emitState(gameId);
  });

  socket.on("chess:invite", (payload = {}) => {
    const { to, gameId } = payload;
    if (!to || !gameId) return;

    const invite = {
      ...payload,
      by: payload.by || effectiveProfileId,
      reinvite: payload.reinvite === true,
      inviteId:
        payload.inviteId ||
        `${String(gameId)}:${String(to)}:${Date.now()}`,
      ts: Date.now(),
    };
    const key = String(to);
    const list = userInvites.get(key) || [];
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
    userInvites.set(key, list);

    io.to(`user_${to}`).emit("chess:invite", {
      ...invite,
      serverTs: Date.now(),
    });
    io.to(`user_${to}`).emit("chess:invites", { invites: list });
  });

  socket.on("chess:accept", (payload = {}) => {
    const { gameId, from, name, avatar } = payload;
    if (!gameId) return;

    const { room, game } = joinRoom(gameId);
    const pid = effectiveProfileId ? String(effectiveProfileId) : null;

    if (game && pid) {
      assignSeat(game, pid, { name, avatar });
    }

    io.to(room).emit("chess:accepted", {
      ...payload,
      profileId: effectiveProfileId,
      serverTs: Date.now(),
    });
    emitState(gameId);

    if (pid) {
      const list = userInvites.get(pid) || [];
      const filtered = list.filter(
        (i) =>
          !(
            String(i.gameId) === String(gameId) &&
            (from ? String(i.by) === String(from) : true)
          ),
      );
      userInvites.set(pid, filtered);
      io.to(`user_${pid}`).emit("chess:invites", { invites: filtered });
    }
  });

  socket.on("chess:invites:get", () => {
    const pid = String(effectiveProfileId || "");
    if (!pid) return;
    const invites = userInvites.get(pid) || [];
    socket.emit("chess:invites", { invites });
  });

  socket.on("chess:invites:dismiss", (payload = {}) => {
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
    io.to(`user_${pid}`).emit("chess:invites", { invites: filtered });
  });

  socket.on("chess:reset", (payload = {}) => {
    const { gameId } = payload;
    if (!gameId) return;

    const game = games.get(gameId);
    if (!game) return;

    game.fen = STARTING_FEN;
    game.lastMove = null;

    io.to(`chess_${gameId}`).emit("chess:reset", {
      gameId,
      serverTs: Date.now(),
    });
    emitState(gameId);
  });

  socket.on("chess:gameover", (payload = {}) => {
    const { gameId } = payload;
    if (!gameId) return;

    io.to(`chess_${gameId}`).emit("chess:gameover", {
      ...payload,
      serverTs: Date.now(),
    });
  });
}

module.exports = chessSocket;
