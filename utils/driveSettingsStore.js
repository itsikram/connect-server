// Google Drive upload storage settings, saved from the admin panel in the shared
// database so every live server picks up new accounts without an .env change.
// Env variables (MEDIA_STORAGE, GDRIVE_*) still work and act as defaults.
const { prisma } = require("./db");

// Each server re-reads the settings this often, so changes reach all servers
const CACHE_TTL_MS = 30000;
const ACCOUNT_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/i;
const BASE_URL_PATTERN = /^(https:\/\/[A-Za-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(?::\d{1,5})?$/;

let cache = { at: 0, doc: null };
let tableReady = null;

// Live databases are not migrated automatically; create the table on first use.
// Matches what `prisma db push` generates for the DriveSettings model.
const ensureTable = () => {
  if (!tableReady) {
    tableReady = prisma
      .$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS \`drivesettings\` (
        \`id\` VARCHAR(32) NOT NULL,
        \`singletonKey\` VARCHAR(32) NOT NULL DEFAULT 'default',
        \`uploadsEnabled\` BOOLEAN NULL,
        \`clientId\` VARCHAR(255) NOT NULL DEFAULT '',
        \`clientSecret\` VARCHAR(255) NOT NULL DEFAULT '',
        \`publicBaseUrl\` VARCHAR(512) NOT NULL DEFAULT '',
        \`accounts\` JSON NULL,
        \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updatedAt\` DATETIME(3) NOT NULL,
        UNIQUE INDEX \`drivesettings_singletonKey_key\`(\`singletonKey\`),
        PRIMARY KEY (\`id\`)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }
  return tableReady;
};

const normalizeAccounts = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .filter((a) => a && ACCOUNT_NAME_PATTERN.test(a.name) && a.refreshToken && !seen.has(a.name) && seen.add(a.name))
    .map((a) => ({
      name: a.name,
      email: String(a.email || ""),
      refreshToken: String(a.refreshToken),
      enabled: a.enabled !== false,
      addedAt: a.addedAt || null,
    }));
};

const normalizeBaseUrl = (value) => {
  const url = String(value || "").trim().replace(/\/+$/, "");
  return BASE_URL_PATTERN.test(url) ? url : "";
};

const loadDriveSettings = async ({ fresh = false } = {}) => {
  if (!fresh && cache.doc && Date.now() - cache.at < CACHE_TTL_MS) return cache.doc;
  await ensureTable();
  const row = await prisma.driveSettings.upsert({
    where: { singletonKey: "default" },
    update: {},
    create: { singletonKey: "default" },
  });
  const doc = {
    uploadsEnabled: row.uploadsEnabled,
    clientId: row.clientId || "",
    clientSecret: row.clientSecret || "",
    publicBaseUrl: row.publicBaseUrl || "",
    accounts: normalizeAccounts(row.accounts),
    updatedAt: row.updatedAt,
  };
  cache = { at: Date.now(), doc };
  return doc;
};

const parseEnvAccounts = () =>
  String(process.env.GDRIVE_ACCOUNTS || "")
    .split(",")
    .map((entry) => {
      const index = entry.indexOf(":");
      if (index < 1) return null;
      const name = entry.slice(0, index).trim();
      const refreshToken = entry.slice(index + 1).trim();
      return ACCOUNT_NAME_PATTERN.test(name) && refreshToken
        ? { name, email: "", refreshToken, enabled: true, source: "env" }
        : null;
    })
    .filter(Boolean);

/**
 * What the Drive storage actually uses: admin settings first, env as fallback.
 * Falls back to env alone when the database is unreachable, so files stay
 * servable while MySQL is down.
 */
const getEffectiveDriveConfig = async () => {
  let doc = null;
  try {
    doc = await loadDriveSettings();
  } catch (error) {
    if (!cache.doc) console.error("[gdrive] settings unavailable, using env:", error?.message || error);
    doc = cache.doc;
  }
  const adminAccounts = (doc?.accounts || []).map((a) => ({ ...a, source: "admin" }));
  const adminNames = new Set(adminAccounts.map((a) => a.name));
  return {
    enabled:
      typeof doc?.uploadsEnabled === "boolean"
        ? doc.uploadsEnabled
        : String(process.env.MEDIA_STORAGE || "").toLowerCase() === "gdrive",
    clientId: doc?.clientId || process.env.GDRIVE_CLIENT_ID || "",
    clientSecret: doc?.clientSecret || process.env.GDRIVE_CLIENT_SECRET || "",
    publicBaseUrl: doc?.publicBaseUrl || process.env.MEDIA_PUBLIC_BASE_URL || "",
    accounts: [...adminAccounts, ...parseEnvAccounts().filter((a) => !adminNames.has(a.name))],
  };
};

const writeSettings = async (data) => {
  await ensureTable();
  await prisma.driveSettings.upsert({
    where: { singletonKey: "default" },
    update: data,
    create: { singletonKey: "default", ...data },
  });
  cache = { at: 0, doc: null };
  return loadDriveSettings({ fresh: true });
};

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** Patch from the admin panel. An empty clientSecret keeps the saved one. */
const updateDriveSettings = async (patch = {}) => {
  const data = {};
  if ("uploadsEnabled" in patch) {
    data.uploadsEnabled = patch.uploadsEnabled === null ? null : Boolean(patch.uploadsEnabled);
  }
  if (typeof patch.clientId === "string") data.clientId = patch.clientId.trim().slice(0, 255);
  if (typeof patch.clientSecret === "string" && patch.clientSecret.trim()) {
    data.clientSecret = patch.clientSecret.trim().slice(0, 255);
  }
  if (typeof patch.publicBaseUrl === "string") {
    const url = normalizeBaseUrl(patch.publicBaseUrl);
    if (patch.publicBaseUrl.trim() && !url) {
      throw badRequest("Public base URL must look like https://api.example.com (no path)");
    }
    data.publicBaseUrl = url;
  }
  return writeSettings(data);
};

const saveAccount = async ({ name, email, refreshToken }) => {
  if (!ACCOUNT_NAME_PATTERN.test(name || "")) throw badRequest("Invalid account name");
  const current = await loadDriveSettings({ fresh: true });
  const existing = current.accounts.find((a) => a.name === name);
  const account = {
    name,
    email,
    refreshToken,
    enabled: existing ? existing.enabled : true,
    addedAt: existing?.addedAt || new Date().toISOString(),
  };
  const accounts = existing
    ? current.accounts.map((a) => (a.name === name ? account : a))
    : [...current.accounts, account];
  return writeSettings({ accounts });
};

const setAccountEnabled = async (name, enabled) => {
  const current = await loadDriveSettings({ fresh: true });
  if (!current.accounts.some((a) => a.name === name)) {
    throw Object.assign(new Error("Account not found"), { status: 404 });
  }
  return writeSettings({
    accounts: current.accounts.map((a) => (a.name === name ? { ...a, enabled: Boolean(enabled) } : a)),
  });
};

const removeAccount = async (name) => {
  const current = await loadDriveSettings({ fresh: true });
  if (!current.accounts.some((a) => a.name === name)) {
    throw Object.assign(new Error("Account not found"), { status: 404 });
  }
  return writeSettings({ accounts: current.accounts.filter((a) => a.name !== name) });
};

module.exports = {
  ACCOUNT_NAME_PATTERN,
  loadDriveSettings,
  getEffectiveDriveConfig,
  updateDriveSettings,
  saveAccount,
  setAccountEnabled,
  removeAccount,
};
