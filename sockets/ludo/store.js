// MySQL persistence for server-hosted Ludo games (the existing `ludogames`
// table). Every change to a game is saved, so a paused or abandoned match
// can be reopened later, from any device, even after a server restart.
//
// Prisma is loaded lazily: the game host also runs without a database (tests,
// or while MySQL is down) and then simply keeps games in memory.

let dbLib;
const getDb = () => {
  if (dbLib === undefined) {
    try {
      dbLib = {
        ...require("../../utils/db"),
        isMySQLReady: require("../../config/prisma").isMySQLReady,
      };
    } catch (_e) {
      dbLib = null;
    }
  }
  return dbLib;
};

const ready = () => {
  const db = getDb();
  try {
    return Boolean(db && db.isMySQLReady());
  } catch (_e) {
    return false;
  }
};

const isProfileId = (value) => Boolean(getDb()?.isValidId(String(value || "")));

const shape = (row) => {
  if (!row) return null;
  const db = getDb();
  return {
    ...row,
    players: db.jsonArray(row.players),
    winners: db.jsonArray(row.winners),
    pausedBy: row.pausedBy ? db.jsonObject(row.pausedBy) : null,
  };
};

const loadGame = async (gameId) => {
  if (!ready() || !gameId) return null;
  const { prisma } = getDb();
  const row = await prisma.ludoGame.findUnique({ where: { gameId: String(gameId) } });
  return shape(row);
};

/** record: the row fields built by the game host (see host.toRecord). */
const saveGame = async (record) => {
  if (!ready() || !record?.gameId || !isProfileId(record.host)) return false;
  const { prisma, Prisma } = getDb();
  const data = {
    ...record,
    pausedBy: record.pausedBy || Prisma.DbNull,
    lastUpdated: new Date(),
  };
  await prisma.ludoGame.upsert({
    where: { gameId: String(record.gameId) },
    create: data,
    update: data,
  });
  return true;
};

const deleteGame = async (gameId) => {
  if (!ready() || !gameId) return false;
  const { prisma } = getDb();
  await prisma.ludoGame.deleteMany({ where: { gameId: String(gameId) } });
  return true;
};

/** Unfinished games a player has a seat in, newest first. */
const listGamesForPlayer = async (profileId, { sinceMs = 30 * 24 * 60 * 60 * 1000, take = 20 } = {}) => {
  if (!ready() || !isProfileId(profileId)) return [];
  const { prisma } = getDb();
  const rows = await prisma.ludoGame.findMany({
    where: {
      playerProfileIds: { array_contains: String(profileId) },
      gameEnded: false,
      lastUpdated: { gte: new Date(Date.now() - sinceMs) },
    },
    orderBy: { lastUpdated: "desc" },
    take,
  });
  return rows.map(shape);
};

/** id -> { fullName, profilePic, coverPic } for real profiles. */
const loadProfiles = async (ids = []) => {
  const wanted = [...new Set(ids.map(String))].filter(isProfileId);
  const out = new Map();
  if (!ready() || wanted.length === 0) return out;
  const { prisma } = getDb();
  const rows = await prisma.profile.findMany({
    where: { id: { in: wanted } },
    select: { id: true, fullName: true, profilePic: true, coverPic: true },
  });
  rows.forEach((row) => out.set(String(row.id), row));
  return out;
};

// Invite notification (bell + web push), like the clients used to send.
const notifyInvite = async (io, { to, from, gameId, slotIndex, playerCount, reinvite, inviteId }) => {
  if (!ready() || !isProfileId(to)) return;
  try {
    const { saveNotification } = require("../../controllers/notificationController");
    const { prisma } = getDb();
    // One open invite per game in the bell: drop the previous one first.
    await prisma.notification.deleteMany({
      where: {
        receiverId: String(to),
        type: "ludo_invite",
        data: { path: "$.gameId", equals: String(gameId) },
      },
    });
    await saveNotification(io, {
      receiverId: String(to),
      title: "Ludo Invitation",
      text: `${from?.name || "A connect"} invited you to play Ludo`,
      icon: from?.avatar || null,
      link: `/ludo-game/${encodeURIComponent(gameId)}`,
      type: "ludo_invite",
      pushTag: `ludo-invite-${gameId}`,
      data: {
        gameId: String(gameId),
        slotIndex,
        playerCount,
        inviterId: from?.profileId ? String(from.profileId) : undefined,
        inviterName: from?.name,
        inviterAvatar: from?.avatar,
        by: from?.profileId ? String(from.profileId) : undefined,
        name: from?.name,
        avatar: from?.avatar,
        reinvite: Boolean(reinvite),
        inviteId,
      },
    });
  } catch (_e) {
    // The live socket invite already went out; the bell entry is a bonus.
  }
};

// Invite resolved (accepted, declined or withdrawn): clear it from the bell.
const clearInviteNotifications = async (profileId, gameId) => {
  if (!ready() || !isProfileId(profileId) || !gameId) return;
  try {
    const { prisma } = getDb();
    await prisma.notification.deleteMany({
      where: {
        receiverId: String(profileId),
        type: "ludo_invite",
        data: { path: "$.gameId", equals: String(gameId) },
      },
    });
  } catch (_e) {}
};

module.exports = {
  ready,
  isProfileId,
  loadGame,
  saveGame,
  deleteGame,
  listGamesForPlayer,
  loadProfiles,
  notifyInvite,
  clearInviteNotifications,
};
