const { prisma, jsonArray } = require("../utils/db");
const ludoSocket = require("../sockets/ludoSocket");

const PROFILE_CARD = { id: true, _id: true, fullName: true, profilePic: true, coverPic: true };

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

// The socket server hosts every game and saves it on each change, so client
// snapshots are no longer written (an older app version must not be able to
// overwrite the server's board). Kept so those versions don't see errors.
exports.saveGameState = async (req, res) =>
  res.status(200).json({
    success: true,
    ignored: true,
    message: "Ludo games are saved by the server",
  });

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

// Leave a game. The game host applies it to the live board too: a host
// leaving ends the game for everyone, a guest hands their seat to the computer.
const leaveThroughHost = async (gameId, profileId) => {
  const result = await ludoSocket.dispatch("leave", gameId, profileId);
  if (result?.ok) return { found: true, removed: Boolean(result.removed) };
  if (result?.error === "not_found") return { found: false, removed: false };
  throw new Error(result?.message || "Ludo game host unavailable");
};

exports.leaveGame = async (req, res) => {
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

    const { found, removed } = await leaveThroughHost(gameId, profileId);
    return res.status(200).json({
      success: true,
      gameRemoved: removed,
      playerRemoved: found && !removed,
      message: found ? "You left the game" : "Game data is already removed",
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
exports.deleteGame = async (req, res) => {
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

    await leaveThroughHost(gameId, profileId);
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
