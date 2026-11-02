// Delivery and read status of chat messages, shared by the socket and HTTP
// paths (sockets/messageSocket.js, controllers/messageController.js).
//
// Status of a message as its sender sees it (clients derive it from the row):
//   not sent  - only on the sender's device (no server id yet, e.g. offline)
//   sent      - saved on the server; the receiver was notified (socket / push)
//   delivered - isDelivered: the receiver had the app open after it was sent
//   seen      - isSeen: the receiver read it (seen implies delivered)
//
// A message becomes delivered when:
//   - it is sent while the receiver has the app open (online in presence);
//   - the receiver's app connects in the foreground or comes back to the
//     foreground (socket connect / presence:active) -> all pending ones;
//   - the receiver's app confirms it got it while open (markDelivered).
//
// Server -> client events:
//   messagesDelivered { senderId, receiverId, room, messageIds, deliveredAt, isDelivered }
//       to the sender's devices
//   messageSeen       (the existing per-message event) for the newest message
//       of each conversation marked read by markAllSeen; it carries
//       `messageIds` with every id marked in that conversation
//   allMessagesSeen   { receiverId, senderIds, connectId, count, seenAt }
//       to the reader's own devices after markAllSeen, to clear unread badges
const { prisma, isValidId } = require("./db");

// Rows handled per query; the loops below page through larger backlogs.
const BATCH_SIZE = 500;
const MAX_BATCHES = 40;

const dbReady = () => {
  try {
    return require("../config/prisma").isMySQLReady();
  } catch (_e) {
    return false;
  }
};

const roomOf = (a, b) => [String(a), String(b)].sort().join("_");

const uniqueIds = (ids) => [
  ...new Set(
    (Array.isArray(ids) ? ids : [ids])
      .filter((id) => id != null && id !== "")
      .map(String)
      .filter((id) => isValidId(id)),
  ),
];

/** "seen" | "delivered" | "sent" for a saved message row. */
const messageStatusOf = (message) => {
  if (!message) return "sent";
  if (message.isSeen) return "seen";
  if (message.isDelivered) return "delivered";
  return "sent";
};

const groupBySender = (rows) => {
  const groups = new Map();
  for (const row of rows) {
    const senderId = String(row.senderId || "");
    if (!senderId) continue;
    if (!groups.has(senderId)) groups.set(senderId, { room: row.room || null, rows: [] });
    groups.get(senderId).rows.push(row);
  }
  return groups;
};

const emitDelivered = (io, receiverId, rows, deliveredAt) => {
  if (!io || typeof io.to !== "function" || !rows.length) return;
  for (const [senderId, group] of groupBySender(rows)) {
    io.to(senderId).emit("messagesDelivered", {
      senderId,
      receiverId: String(receiverId),
      room: group.room || roomOf(senderId, receiverId),
      messageIds: group.rows.map((row) => String(row.id)),
      deliveredAt,
      isDelivered: true,
    });
  }
};

/**
 * Mark messages to `receiverId` as delivered and tell their senders.
 * Without `messageIds`, every pending (unseen, undelivered) message is marked.
 * Only the receiver's own messages are ever touched.
 */
async function markDelivered(io, { receiverId, messageIds } = {}) {
  const me = String(receiverId || "");
  const result = { count: 0, messageIds: [] };
  if (!isValidId(me)) return result;

  const where = { receiverId: me, isSeen: false, isDelivered: false };
  if (messageIds !== undefined) {
    const ids = uniqueIds(messageIds).slice(0, BATCH_SIZE);
    if (!ids.length) return result;
    where.id = { in: ids };
  }

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await prisma.message.findMany({
      where,
      select: { id: true, senderId: true, room: true },
      orderBy: { timestamp: "asc" },
      take: BATCH_SIZE,
    });
    if (!rows.length) break;
    const deliveredAt = new Date();
    const { count } = await prisma.message.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, isDelivered: false },
      data: { isDelivered: true, deliveredAt },
    });
    if (count > 0) {
      emitDelivered(io, me, rows, deliveredAt);
      result.count += count;
      result.messageIds.push(...rows.map((row) => String(row.id)));
    }
    // Specific ids fit in one batch; a short page means nothing is left.
    if (where.id || rows.length < BATCH_SIZE || count === 0) break;
  }
  return result;
}

// receiverId -> { again, promise }: one run at a time per profile; calls that
// arrive meanwhile are folded into a single follow-up run.
const pendingRuns = new Map();

/** Deliver everything waiting for `receiverId` (their app is open now). */
function deliverPending(io, receiverId) {
  const id = String(receiverId || "");
  if (!isValidId(id) || !dbReady()) return Promise.resolve({ count: 0, messageIds: [] });
  const running = pendingRuns.get(id);
  if (running) {
    running.again = true;
    return running.promise;
  }
  const entry = { again: false, promise: null };
  pendingRuns.set(id, entry);
  entry.promise = (async () => {
    const total = { count: 0, messageIds: [] };
    try {
      do {
        entry.again = false;
        const result = await markDelivered(io, { receiverId: id });
        total.count += result.count;
        total.messageIds.push(...result.messageIds);
      } while (entry.again);
    } catch (error) {
      console.error("[message-status] deliver pending failed:", error?.message || error);
    } finally {
      pendingRuns.delete(id);
    }
    return total;
  })();
  return entry.promise;
}

/** A message was just sent: delivered right away if the receiver has the app open. */
async function deliverIfReceiverOnline(io, message) {
  const receiverId = String(message?.receiverId || "");
  const senderId = String(message?.senderId || "");
  const messageId = String(message?._id || message?.id || "");
  const none = { count: 0, messageIds: [] };
  if (!isValidId(receiverId) || !messageId || receiverId === senderId) return none;
  if (message.isSeen || message.isDelivered) return none;
  const presence = require("../sockets/presence");
  const online = presence.isLocallyOnline(receiverId)
    || Boolean((await presence.getStatuses([receiverId]))[receiverId]?.isActive);
  if (!online) return none;
  return markDelivered(io, { receiverId, messageIds: [messageId] });
}

/** Seen implies delivered: fill in the delivery fields for newly seen rows. */
async function markDeliveredWithSeen(messageIds, at = new Date()) {
  const ids = uniqueIds(messageIds);
  if (!ids.length) return 0;
  const { count } = await prisma.message.updateMany({
    where: { id: { in: ids }, isDelivered: false },
    data: { isDelivered: true, deliveredAt: at },
  });
  return count;
}

/**
 * "Mark all as read": every unseen message to `receiverId` (only from
 * `connectId` when given) becomes seen. Both sides are told on every device.
 */
async function markAllSeen(io, { receiverId, connectId } = {}) {
  const me = String(receiverId || "");
  const result = { count: 0, senderIds: [], messageIds: [], seenAt: null };
  if (!isValidId(me)) return result;
  if (connectId != null && connectId !== "" && !isValidId(connectId)) return result;

  const where = { receiverId: me, isSeen: false };
  if (connectId) where.senderId = String(connectId);

  const seenAt = new Date();
  // senderId -> { room, ids, latest }
  const conversations = new Map();
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await prisma.message.findMany({
      where,
      select: { id: true, senderId: true, room: true, timestamp: true, isDelivered: true },
      orderBy: { timestamp: "asc" },
      take: BATCH_SIZE,
    });
    if (!rows.length) break;
    const ids = rows.map((row) => row.id);
    await markDeliveredWithSeen(rows.filter((row) => !row.isDelivered).map((row) => row.id), seenAt);
    const { count } = await prisma.message.updateMany({
      where: { id: { in: ids }, isSeen: false },
      data: { isSeen: true },
    });
    result.count += count;
    for (const row of rows) {
      const senderId = String(row.senderId || "");
      if (!senderId) continue;
      if (!conversations.has(senderId)) conversations.set(senderId, { room: row.room, ids: [], latest: row });
      const entry = conversations.get(senderId);
      entry.ids.push(String(row.id));
      if (new Date(row.timestamp) >= new Date(entry.latest.timestamp)) entry.latest = row;
      if (!entry.room && row.room) entry.room = row.room;
    }
    if (rows.length < BATCH_SIZE || count === 0) break;
  }

  result.senderIds = [...conversations.keys()];
  result.messageIds = [...conversations.values()].flatMap((entry) => entry.ids);
  result.seenAt = seenAt;
  if (!io || typeof io.to !== "function") return result;

  for (const [senderId, entry] of conversations) {
    const room = entry.room || roomOf(senderId, me);
    // Same shape as POST /message/seen. Clients mark this message and every
    // earlier one from the same sender, so older clients stay in step too.
    io.to([room, senderId, me]).emit("messageSeen", {
      messageId: String(entry.latest.id),
      _id: String(entry.latest.id),
      room,
      senderId,
      receiverId: me,
      messageTimestamp: entry.latest.timestamp,
      messageIds: entry.ids,
      seenBy: me,
      timestamp: seenAt,
    });
  }
  if (result.count > 0) {
    io.to(me).emit("allMessagesSeen", {
      receiverId: me,
      senderIds: result.senderIds,
      connectId: connectId ? String(connectId) : null,
      count: result.count,
      seenAt,
    });
  }
  return result;
}

module.exports = {
  messageStatusOf,
  markDelivered,
  deliverPending,
  deliverIfReceiverOnline,
  markDeliveredWithSeen,
  markAllSeen,
};
