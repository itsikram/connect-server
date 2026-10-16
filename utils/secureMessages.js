// Vanishing "secure" chat messages.
//
// The `messages` row of a secure message only holds a placeholder
// (messageType "secure", message "🔒 Secure message", no attachment), so push
// notifications, chat-list previews, reminder emails, AI features and older
// clients never see the content. The real text / attachment is AES-256-GCM
// encrypted in `securemessages` and handed out exactly once — to the receiver,
// by openSecureMessage(). Unopened messages expire after SECURE_TTL_MS; the
// cleanup worker wipes expired content and deletes attachments from storage.
//
// Key: SECURE_MESSAGE_KEY (32 bytes as base64 or 64 hex chars). Without it a
// key derived from the JWT secret is used, which every server already shares.
const crypto = require("crypto");
const { prisma, isValidId } = require("./db");
const { deleteCloudinaryResources } = require("./cloudinaryCleanup");

const SECURE_MESSAGE_TYPE = "secure";
const SECURE_PLACEHOLDER = "🔒 Secure message";
const SECURE_TTL_MS = 24 * 60 * 60 * 1000;
// An opened photo stays downloadable this long so the viewer can load it.
const OPENED_ATTACHMENT_GRACE_MS = 2 * 60 * 1000;
const MAX_SECURE_TEXT = 4000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

let keyCache = null;
const parseKey = (raw) => {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  return decoded.length === 32 ? decoded : null;
};
const loadKeys = () => {
  if (keyCache) return keyCache;
  const primary = parseKey(process.env.SECURE_MESSAGE_KEY);
  if (process.env.SECURE_MESSAGE_KEY && !primary) {
    console.warn("[secure-message] SECURE_MESSAGE_KEY must be 32 bytes (base64) or 64 hex characters; using the fallback key.");
  }
  const jwtSecret = String(process.env.JWT_SECRET_KEY || process.env.JWT_SECRET || "connect-dev-secret");
  const fallback = crypto.createHash("sha256").update(`connect-secure-message:${jwtSecret}`).digest();
  keyCache = { v1: primary, v0: fallback };
  return keyCache;
};

const encryptJson = (value) => {
  const keys = loadKeys();
  const version = keys.v1 ? "v1" : "v0";
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keys[version], iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${version}:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
};

const decryptJson = (value) => {
  if (!value || typeof value !== "string") return null;
  const [version, ivText, tagText, dataText] = value.split(":");
  const key = loadKeys()[version];
  if (!key || !ivText || !tagText) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(dataText || "", "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(text);
  } catch (_) {
    console.warn("[secure-message] could not decrypt a stored payload");
    return null;
  }
};

// Live databases are not migrated automatically; create the table on first use.
// Matches what `prisma db push` generates for the SecureMessage model.
let tableReady = null;
const ensureTable = () => {
  if (!tableReady) {
    tableReady = prisma
      .$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS \`securemessages\` (
        \`id\` VARCHAR(32) NOT NULL,
        \`senderId\` VARCHAR(64) NOT NULL,
        \`receiverId\` VARCHAR(64) NOT NULL,
        \`payload\` TEXT NOT NULL,
        \`expiresAt\` DATETIME(3) NOT NULL,
        \`openedAt\` DATETIME(3) NULL,
        \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX \`securemessages_expiresAt_idx\`(\`expiresAt\`),
        PRIMARY KEY (\`id\`)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }
  return tableReady;
};

const isSecureRequest = (payload) => Boolean(payload && (payload.secure === true || payload.isSecure === true));
const isSecureMessage = (message) => Boolean(message && message.messageType === SECURE_MESSAGE_TYPE);

const stateOf = (row, now = Date.now()) => {
  if (!row) return { state: "expired", expiresAt: null, openedAt: null };
  if (row.openedAt) return { state: "opened", expiresAt: row.expiresAt, openedAt: row.openedAt };
  if (new Date(row.expiresAt).getTime() <= now) return { state: "expired", expiresAt: row.expiresAt, openedAt: null };
  return { state: "sealed", expiresAt: row.expiresAt, openedAt: null };
};

/**
 * Validates a secure send. Returns { ok: true, content } or { ok: false, error }.
 * Voice notes and call logs cannot be secure; photos/videos/files can.
 */
function prepareSecureContent({ message, attachment, messageType }) {
  const text = message == null ? "" : String(message).trim();
  const file = typeof attachment === "string" && /^https?:\/\//i.test(attachment) ? attachment : "";
  if (!text && !file) return { ok: false, error: "A secure message needs text or a photo" };
  if (text.length > MAX_SECURE_TEXT) return { ok: false, error: `Secure messages are limited to ${MAX_SECURE_TEXT} characters` };
  const kind = String(messageType || "text");
  if (kind === "call" || kind === "audio") return { ok: false, error: "Voice notes and calls cannot be sent as secure messages" };
  return { ok: true, content: { text, attachment: file, kind: kind === SECURE_MESSAGE_TYPE ? "text" : kind } };
}

/**
 * Creates the placeholder `messages` row and its encrypted content. Returns
 * the new message row (same shape prisma.message.create returns).
 */
async function createSecureMessage({ room, senderId, receiverId, parent, tempId, content }) {
  await ensureTable();
  const created = await prisma.message.create({
    data: {
      room,
      senderId: String(senderId),
      receiverId: String(receiverId),
      message: SECURE_PLACEHOLDER,
      ...(parent && isValidId(parent) ? { parent: String(parent) } : {}),
      messageType: SECURE_MESSAGE_TYPE,
      tempId: tempId == null ? undefined : String(tempId),
      reacts: [],
    },
  });
  try {
    await prisma.secureMessage.create({
      data: {
        id: created.id,
        senderId: String(senderId),
        receiverId: String(receiverId),
        payload: encryptJson(content),
        expiresAt: new Date(Date.now() + SECURE_TTL_MS),
      },
    });
  } catch (error) {
    // Never leave a placeholder without content behind.
    await prisma.message.deleteMany({ where: { id: created.id } }).catch(() => {});
    throw error;
  }
  return created;
}

/**
 * Adds `secure: { state, expiresAt, openedAt }` to every secure message in
 * `messages` (an array or a single row). Content is never included.
 */
async function withSecureState(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  const ids = list.filter(isSecureMessage).map((m) => String(m.id || m._id));
  if (ids.length === 0) return messages;
  let rows = [];
  try {
    await ensureTable();
    rows = await prisma.secureMessage.findMany({
      where: { id: { in: ids } },
      select: { id: true, expiresAt: true, openedAt: true },
    });
  } catch (error) {
    console.error("[secure-message] state lookup failed:", error?.message || error);
  }
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const now = Date.now();
  list.forEach((message) => {
    if (!isSecureMessage(message)) return;
    message.attachment = null;
    message.message = SECURE_PLACEHOLDER;
    message.secure = stateOf(byId.get(String(message.id || message._id)), now);
  });
  return messages;
}

/**
 * One-time read by the receiver. Returns
 *   { ok: true, content: { text, attachment, kind }, openedAt, message }
 *   { ok: false, status, error, state? }
 */
async function openSecureMessage({ messageId, profileId }) {
  if (!isValidId(messageId)) return { ok: false, status: 400, error: "Invalid message id" };
  const message = await prisma.message.findUnique({ where: { id: String(messageId) } });
  if (!isSecureMessage(message)) return { ok: false, status: 404, error: "Secure message not found" };
  const me = String(profileId || "");
  if (String(message.receiverId) !== me) {
    if (String(message.senderId) === me) {
      return { ok: false, status: 403, error: "Only the receiver can open a secure message" };
    }
    return { ok: false, status: 403, error: "Message access denied" };
  }

  await ensureTable();
  const row = await prisma.secureMessage.findUnique({ where: { id: message.id } });
  const current = stateOf(row);
  if (current.state !== "sealed") {
    return { ok: false, status: 410, error: current.state === "opened" ? "Already opened" : "This secure message expired", state: current.state };
  }
  const content = decryptJson(row.payload);
  if (!content) return { ok: false, status: 410, error: "This secure message can no longer be opened", state: "expired" };

  const openedAt = new Date();
  // Text is wiped right away; a photo is kept briefly so it can load, then
  // the cleanup worker deletes it from storage.
  const keepAttachment = Boolean(content.attachment);
  const { count } = await prisma.secureMessage.updateMany({
    where: { id: message.id, openedAt: null },
    data: {
      openedAt,
      payload: keepAttachment ? encryptJson({ attachment: content.attachment }) : "",
      expiresAt: new Date(openedAt.getTime() + (keepAttachment ? OPENED_ATTACHMENT_GRACE_MS : 0)),
    },
  });
  // Another device of the receiver won the race.
  if (!count) return { ok: false, status: 410, error: "Already opened", state: "opened" };

  await prisma.message.updateMany({ where: { id: message.id, isSeen: false }, data: { isSeen: true } }).catch(() => {});
  return {
    ok: true,
    openedAt,
    message,
    content: { text: content.text || "", attachment: content.attachment || "", kind: content.kind || "text" },
  };
}

const attachmentsOf = (rows) =>
  rows
    .map((row) => decryptJson(row.payload))
    .map((content) => content && content.attachment)
    .filter(Boolean);

/** Deletes the secure rows (and stored attachments) of deleted messages. */
async function deleteSecureContent(messageIds) {
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).map(String).filter(Boolean);
  if (ids.length === 0) return;
  try {
    await ensureTable();
    const rows = await prisma.secureMessage.findMany({ where: { id: { in: ids } }, select: { id: true, payload: true } });
    if (rows.length === 0) return;
    await prisma.secureMessage.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    await deleteCloudinaryResources(attachmentsOf(rows));
  } catch (error) {
    console.error("[secure-message] cleanup on delete failed:", error?.message || error);
  }
}

/** Wipes expired content (unopened past 24h, opened photos past their grace period). */
async function purgeExpiredSecureMessages() {
  try {
    await ensureTable();
    const rows = await prisma.secureMessage.findMany({
      where: { payload: { not: "" }, expiresAt: { lt: new Date() } },
      select: { id: true, payload: true },
      take: 200,
    });
    if (rows.length === 0) return 0;
    const { count } = await prisma.secureMessage.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, payload: { not: "" } },
      data: { payload: "" },
    });
    await deleteCloudinaryResources(attachmentsOf(rows));
    return count;
  } catch (error) {
    console.error("[secure-message] purge failed:", error?.message || error);
    return 0;
  }
}

let sweepTimer = null;
function startSecureMessageWorker() {
  if (sweepTimer) return;
  purgeExpiredSecureMessages();
  sweepTimer = setInterval(purgeExpiredSecureMessages, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

module.exports = {
  SECURE_MESSAGE_TYPE,
  SECURE_PLACEHOLDER,
  SECURE_TTL_MS,
  isSecureRequest,
  isSecureMessage,
  prepareSecureContent,
  createSecureMessage,
  withSecureState,
  openSecureMessage,
  deleteSecureContent,
  purgeExpiredSecureMessages,
  startSecureMessageWorker,
};
