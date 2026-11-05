// Newest-first pages of the conversation between two profiles.
//
// `WHERE (senderId = a AND receiverId = b) OR (senderId = b AND receiverId = a)
// ORDER BY timestamp DESC` cannot be read in index order, so MySQL fetched and
// sorted the whole conversation for every page. Here each direction is read
// on its own, already in (senderId, receiverId, timestamp) index order, and
// only the rows the page can need are merged. The page's rows are then loaded
// by id with the caller's Prisma options (include / omit / select) and
// returned in the same order: timestamp desc, id desc, as before.
const { Prisma } = require("@prisma/client");
const { prisma } = require("../config/prisma");

const toCount = (value) => Math.max(0, Math.trunc(Number(value)) || 0);

/** Ids of one page, newest first. `before`: only messages older than this Date. */
async function conversationPageIds(a, b, { skip = 0, take, before } = {}) {
  const me = String(a);
  const other = String(b);
  const offset = toCount(skip);
  const limit = toCount(take);
  if (!limit) return [];
  const older = before ? Prisma.sql`AND timestamp < ${before}` : Prisma.empty;

  // A chat with yourself has one direction only.
  if (me === other) {
    const rows = await prisma.$queryRaw`
      SELECT id FROM messages
      WHERE senderId = ${me} AND receiverId = ${me} ${older}
      ORDER BY timestamp DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}`;
    return rows.map((row) => row.id);
  }

  // The page lies within the newest offset + limit rows of each direction.
  const depth = offset + limit;
  const rows = await prisma.$queryRaw`
    (SELECT id, timestamp FROM messages
      WHERE senderId = ${me} AND receiverId = ${other} ${older}
      ORDER BY timestamp DESC, id DESC LIMIT ${depth})
    UNION ALL
    (SELECT id, timestamp FROM messages
      WHERE senderId = ${other} AND receiverId = ${me} ${older}
      ORDER BY timestamp DESC, id DESC LIMIT ${depth})
    ORDER BY timestamp DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}`;
  return rows.map((row) => row.id);
}

/**
 * Same rows and order as
 *   prisma.message.findMany({ where: <both directions>, orderBy: [{ timestamp: "desc" }, { id: "desc" }], skip, take, ...args })
 * `args` may carry include / omit / select (a select must keep `id`).
 */
async function findConversationPage(a, b, { skip, take, before, ...args } = {}) {
  const ids = await conversationPageIds(a, b, { skip, take, before });
  if (!ids.length) return [];
  const rows = await prisma.message.findMany({ ...args, where: { id: { in: ids } } });
  const position = new Map(ids.map((id, index) => [id, index]));
  return rows.sort((x, y) => position.get(x.id) - position.get(y.id));
}

/**
 * Ids of the latest message per peer, in one direction: "sent" (peer =
 * receiver) or "received" (peer = sender). Reads the (senderId, receiverId,
 * timestamp) index one peer at a time instead of numbering every message the
 * profile ever sent or received. Messages sharing a peer's latest timestamp
 * are all returned.
 */
function latestMessageIdsByPeer(profileId, direction) {
  const me = String(profileId);
  const query =
    direction === "sent"
      ? prisma.$queryRaw`
          SELECT m.id FROM messages m
          JOIN (SELECT receiverId AS peer, MAX(timestamp) AS ts FROM messages
                WHERE senderId = ${me} GROUP BY receiverId) latest
            ON m.senderId = ${me} AND m.receiverId = latest.peer AND m.timestamp = latest.ts`
      : prisma.$queryRaw`
          SELECT m.id FROM messages m
          JOIN (SELECT senderId AS peer, MAX(timestamp) AS ts FROM messages
                WHERE receiverId = ${me} GROUP BY senderId) latest
            ON m.receiverId = ${me} AND m.senderId = latest.peer AND m.timestamp = latest.ts`;
  return query.then((rows) => rows.map((row) => row.id));
}

module.exports = { conversationPageIds, findConversationPage, latestMessageIdsByPeer };
