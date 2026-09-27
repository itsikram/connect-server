const crypto = require("crypto");

// Field-level encryption for Recovery free text (journal, notes, chat, contacts).
// Values are stored as "<version>:<iv>:<tag>:<ciphertext>" (base64 parts):
//   v1 = RECOVERY_DATA_KEY (32 bytes as base64 or 64 hex chars) — use in production.
//   v0 = key derived from the JWT secret, only used when RECOVERY_DATA_KEY is unset
//        so development works without extra setup. Existing v0 values stay readable
//        after RECOVERY_DATA_KEY is added, as long as the JWT secret is unchanged.
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VALUE_PATTERN = /^v[01]:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/;

let keyCache = null;
let warnedFallback = false;

const parseKey = (raw) => {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  return decoded.length === 32 ? decoded : null;
};

const loadKeys = () => {
  if (keyCache) return keyCache;
  const primary = parseKey(process.env.RECOVERY_DATA_KEY);
  if (process.env.RECOVERY_DATA_KEY && !primary) {
    console.warn("[recovery] RECOVERY_DATA_KEY must be 32 bytes (base64) or 64 hex characters; using the fallback key.");
  }
  const jwtSecret = String(process.env.JWT_SECRET_KEY || process.env.JWT_SECRET || "connect-dev-secret");
  const fallback = crypto.createHash("sha256").update(`connect-recovery:${jwtSecret}`).digest();
  keyCache = { v1: primary, v0: fallback };
  return keyCache;
};

const activeVersion = () => {
  const keys = loadKeys();
  if (keys.v1) return "v1";
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn("[recovery] RECOVERY_DATA_KEY is not set; encrypting recovery data with a key derived from the JWT secret.");
  }
  return "v0";
};

const isEncrypted = (value) => typeof value === "string" && VALUE_PATTERN.test(value);

const encryptText = (plain) => {
  if (plain === undefined || plain === null) return "";
  const text = String(plain);
  if (!text) return "";
  const version = activeVersion();
  const key = loadKeys()[version];
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${version}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
};

/** Returns "" for empty, tampered or undecryptable values; plain legacy text passes through. */
const decryptText = (value) => {
  if (!value) return "";
  if (!isEncrypted(value)) return String(value);
  const [version, ivText, tagText, dataText] = value.split(":");
  const key = loadKeys()[version];
  if (!key) return "";
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataText, "base64")), decipher.final()]).toString("utf8");
  } catch (_) {
    console.warn("[recovery] could not decrypt a stored value");
    return "";
  }
};

const encryptJson = (value) => (value === undefined || value === null ? "" : encryptText(JSON.stringify(value)));

const decryptJson = (value, fallback = null) => {
  const text = decryptText(value);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
};

/** Test helper: forget cached keys after changing environment variables. */
const resetKeyCache = () => {
  keyCache = null;
  warnedFallback = false;
};

module.exports = { encryptText, decryptText, encryptJson, decryptJson, isEncrypted, resetKeyCache };
