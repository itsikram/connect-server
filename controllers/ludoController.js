const { prisma, isValidId, isDuplicate, jsonArray } = require("../utils/db");

const PROFILE_CARD = { id: true, _id: true, fullName: true, profilePic: true, coverPic: true };

// players[].profileId, kept in sync on every write so games can be queried by player.
const playerProfileIdsOf = (players) => [
  ...new Set(
    jsonArray(players)
      .map((p) => (p && p.profileId ? String(p.profileId) : ""))
      .filter(Boolean),
  ),
];

// Mongoose populate("host") + populate("players.profileId") equivalent.
async function populateGames(games) {
  const list = games.filter(Boolean);
  const ids = new Set();
  list.forEach((g) => {
    if (g.host) ids.add(String(g.host));
    jsonArray(g.players).forEach((p) => p?.profileId && ids.add(String(p.profileId)));
  });
  const profiles = ids.size
    ? await prisma.profile.findMany({ where: { id: { in: [...ids] } }, select: PROFILE_CARD })
    : [];
  const byId = new Map(profiles.map((p) => [p.id, p]));
  list.forEach((g) => {
    g.host = byId.get(String(g.host)) || null;
    g.players = jsonArray(g.players).map((p) =>
      p && p.profileId ? { ...p, profileId: byId.get(String(p.profileId)) || null } : p,
    );
  });
  return games;
}

// Save or update game state
exports.saveGameState = async (req, res, next) => {
  try {
    const {
      gameId,
      players,
      currentPlayer,
      diceValue,
      gameStarted,
      gameEnded,
      winners,
      selectedPlayerCount,
      stateVersion,
      playersSeq,
    } = req.body;

    // Validate required fields
    if (!gameId) {
      return res.status(400).json({
        success: false,
        message: "Game ID is required",
      });
    }

    // Get host profile from auth middleware
    const hostId = req.profile?._id;
    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    // Validate players array
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Players array is required",
      });
    }

    // Use findOneAndUpdate with upsert to handle race conditions atomically
    // First check if game exists to validate host permissions
    const existingGame = await prisma.ludoGame.findUnique({ where: { gameId: String(gameId) } });

    if (existingGame && String(existingGame.host) !== String(hostId)) {
      return res.status(403).json({
        success: false,
        message: "Only the host can update the game state",
      });
    }

    // Bot/local seats carry ids like "bot-1" or "local" that are not
    // ObjectIds; strip them so the snapshot still validates and saves.
    const toObjectIdOrUndefined = (value) =>
      value && isValidId(String(value)) &&
      String(value).length === 24
        ? value
        : undefined;
    const sanitizedPlayers = players.map((player) => ({
      ...player,
      profileId: toObjectIdOrUndefined(player?.profileId),
    }));
    const sanitizedWinners = Array.isArray(winners)
      ? winners.map((winner) => ({
          ...winner,
          profileId: toObjectIdOrUndefined(winner?.profileId),
        }))
      : winners;

    // Pause state (paused/pausedAt/pausedBy) is written only by the socket
    // server's ludo:pause / ludo:resume, never from a host snapshot: the host
    // may save a move before it has heard about a pause.
    const incomingVersion = Math.max(
      Number(stateVersion || 0),
      Number(playersSeq || 0),
      0,
    );

    const gameData = {
        stateVersion: Math.max(incomingVersion, existingGame?.stateVersion || 0),
        gameId,
        host: hostId,
        players: sanitizedPlayers,
        currentPlayer:
          currentPlayer !== undefined
            ? currentPlayer
            : existingGame?.currentPlayer || 0,
        diceValue:
          diceValue !== undefined ? diceValue : existingGame?.diceValue || 0,
        gameStarted:
          gameStarted !== undefined
            ? gameStarted
            : existingGame?.gameStarted || false,
        gameEnded:
          gameEnded !== undefined
            ? gameEnded
            : existingGame?.gameEnded || false,
        winners: sanitizedWinners || existingGame?.winners || [],
        selectedPlayerCount:
          selectedPlayerCount || existingGame?.selectedPlayerCount || 4,
        lastUpdated: new Date(),
    };
    gameData.gameId = String(gameId);
    gameData.host = String(hostId);
    gameData.playerProfileIds = playerProfileIdsOf(sanitizedPlayers);
    const game = await prisma.ludoGame.upsert({
      where: { gameId: gameData.gameId },
      create: gameData,
      update: gameData,
    });

    return res.status(200).json({
      success: true,
      message: "Game state saved successfully",
      game,
    });
  } catch (error) {
    console.error("Error saving game state:", error);
    if (isDuplicate(error)) {
      // Duplicate key error (gameId already exists)
      return res.status(409).json({
        success: false,
        message: "Game with this ID already exists",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Get game state by gameId
exports.getGameState = async (req, res, next) => {
  try {
    const { gameId } = req.query;

    if (!gameId) {
      return res.status(400).json({
        success: false,
        message: "Game ID is required",
      });
    }

    const game = await prisma.ludoGame.findUnique({ where: { gameId: String(gameId) } });
    if (game) await populateGames([game]);

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }

    return res.status(200).json({
      success: true,
      game,
    });
  } catch (error) {
    console.error("Error getting game state:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Get all games for a user (as host or player)
exports.getUserGames = async (req, res, next) => {
  try {
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    // Find games where user is host or player
    const games = await prisma.ludoGame.findMany({
      where: {
        OR: [
          { host: String(profileId) },
          { playerProfileIds: { array_contains: String(profileId) } },
        ],
        gameEnded: false, // Only return active games
      },
      orderBy: { lastUpdated: "desc" },
      take: 50,
    });
    await populateGames(games);

    return res.status(200).json({
      success: true,
      count: games.length,
      games,
    });
  } catch (error) {
    console.error("Error getting user games:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Leave a game and remove the authenticated user's persisted match data.
// A host leaving ends the room; a guest leaving only vacates their own seat.
exports.leaveGame = async (req, res, next) => {
  try {
    const { gameId } = req.body || {};
    const profileId = req.profile?._id;

    if (!gameId) {
      return res.status(400).json({
        success: false,
        message: "Game ID is required",
      });
    }

    if (!profileId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const game = await prisma.ludoGame.findUnique({ where: { gameId: String(gameId) } });
    if (!game) {
      return res.status(200).json({
        success: true,
        message: "Game data is already removed",
      });
    }

    if (String(game.host) === String(profileId)) {
      await prisma.ludoGame.deleteMany({ where: { gameId: String(gameId) } });
      return res.status(200).json({
        success: true,
        gameRemoved: true,
        message: "Game data removed successfully",
      });
    }

    let playerRemoved = false;
    game.players = jsonArray(game.players);
    game.players.forEach((player, index) => {
      if (player?.profileId && String(player.profileId) === String(profileId)) {
        player.profileId = null;
        player.name = `Player ${index + 1}`;
        player.avatar = null;
        player.cover = null;
        player.isActive = false;
        player.isOffline = false;
        player.isBot = false;
        playerRemoved = true;
      }
    });

    if (playerRemoved) {
      await prisma.ludoGame.update({
        where: { id: game.id },
        data: {
          players: game.players,
          playerProfileIds: playerProfileIdsOf(game.players),
          lastUpdated: new Date(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      gameRemoved: false,
      playerRemoved,
      message: "Player data removed successfully",
    });
  } catch (error) {
    console.error("Error leaving Ludo game:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Delete game (only host can delete)
exports.deleteGame = async (req, res, next) => {
  try {
    const { gameId } = req.body || req.query;
    const profileId = req.profile?._id;

    if (!gameId) {
      return res.status(400).json({
        success: false,
        message: "Game ID is required",
      });
    }

    if (!profileId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const game = await prisma.ludoGame.findUnique({ where: { gameId: String(gameId) } });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found",
      });
    }

    // Only host can delete
    if (String(game.host) !== String(profileId)) {
      return res.status(403).json({
        success: false,
        message: "Only the host can delete the game",
      });
    }

    await prisma.ludoGame.deleteMany({ where: { gameId: String(gameId) } });

    return res.status(200).json({
      success: true,
      message: "Game deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting game:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Clean up old ended games (optional maintenance endpoint)
exports.cleanupOldGames = async (req, res, next) => {
  try {
    // Only allow admins or run as scheduled job
    // For now, we'll just return a message
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const deleted = await prisma.ludoGame.deleteMany({
      where: { gameEnded: true, lastUpdated: { lt: thirtyDaysAgo } },
    });
    const result = { deletedCount: deleted.count };

    return res.status(200).json({
      success: true,
      message: `Cleaned up ${result.deletedCount} old games`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error cleaning up games:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
