// Which live servers the web and Expo clients use. Saved from the admin panel
// in the shared database, so every live server hands out the same list.
const ServerSettings = require("../models/ServerSettings");

const CACHE_TTL_MS = 15000;
const MODES = ["multi", "single"];
const STRATEGIES = ["random", "priority"];

// Used until an admin saves a list. SERVER_URLS="https://a,https://b" overrides.
const DEFAULT_SERVER_URLS = ["https://onlinestorefrontsigns.com"];

// https only (plain http allowed for localhost during development), optional
// port and path prefix, no query or fragment.
const SERVER_URL_PATTERN =
  /^(https:\/\/[A-Za-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(?::\d{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/;

const normalizeUrl = (value) => {
  const url = String(value || "").trim().replace(/\/+$/, "");
  return SERVER_URL_PATTERN.test(url) ? url : "";
};

const defaultServers = () => {
  const fromEnv = String(process.env.SERVER_URLS || "")
    .split(",")
    .map(normalizeUrl)
    .filter(Boolean);
  return (fromEnv.length ? fromEnv : DEFAULT_SERVER_URLS).map((url) => ({
    url,
    label: "",
    enabled: true,
  }));
};

const defaultSettings = () => ({
  mode: "multi",
  servers: defaultServers(),
  singleServerUrl: "",
  strategy: "random",
  downCooldownSeconds: 60,
  updatedAt: null,
});

const normalizeServers = (value) => {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const servers = [];
  for (const item of value) {
    const url = normalizeUrl(typeof item === "string" ? item : item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    servers.push({
      url,
      label: String(item?.label || "").trim().slice(0, 80),
      enabled: item?.enabled !== false,
    });
  }
  return servers;
};

const fromRow = (row) => {
  const base = defaultSettings();
  if (!row) return base;
  const servers = normalizeServers(row.servers);
  return {
    mode: MODES.includes(row.mode) ? row.mode : base.mode,
    servers: servers && servers.length ? servers : base.servers,
    singleServerUrl: normalizeUrl(row.singleServerUrl),
    strategy: STRATEGIES.includes(row.strategy) ? row.strategy : base.strategy,
    downCooldownSeconds: Number.isFinite(row.downCooldownSeconds)
      ? row.downCooldownSeconds
      : base.downCooldownSeconds,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
};

let cache = { at: 0, settings: null };

async function loadServerSettings({ fresh = false } = {}) {
  if (!fresh && cache.settings && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.settings;
  }
  try {
    const row = await ServerSettings.findOne({ singletonKey: "default" }).lean();
    cache = { at: Date.now(), settings: fromRow(row) };
  } catch (error) {
    // Database hiccup: keep handing out the last known list.
    if (!cache.settings) cache = { at: Date.now(), settings: defaultSettings() };
    console.warn("[server-settings] load failed:", error.message);
  }
  return cache.settings;
}

/** Validates an admin update; throws an Error with `status = 400` on bad input. */
function validateUpdate(body = {}, current) {
  const fail = (message) => {
    const error = new Error(message);
    error.status = 400;
    throw error;
  };
  const next = { ...current };

  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode)) fail('mode must be "multi" or "single"');
    next.mode = body.mode;
  }
  if (body.strategy !== undefined) {
    if (!STRATEGIES.includes(body.strategy)) fail('strategy must be "random" or "priority"');
    next.strategy = body.strategy;
  }
  if (body.downCooldownSeconds !== undefined) {
    const seconds = Number(body.downCooldownSeconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
      fail("downCooldownSeconds must be a whole number from 5 to 3600");
    }
    next.downCooldownSeconds = seconds;
  }
  if (body.servers !== undefined) {
    if (!Array.isArray(body.servers)) fail("servers must be a list");
    const bad = body.servers.find(
      (item) => !normalizeUrl(typeof item === "string" ? item : item?.url),
    );
    if (bad !== undefined) {
      fail(`Invalid server URL: ${typeof bad === "string" ? bad : bad?.url || "(empty)"}. Use https://host[:port]`);
    }
    next.servers = normalizeServers(body.servers);
  }
  if (body.singleServerUrl !== undefined) {
    const raw = String(body.singleServerUrl || "").trim();
    const url = normalizeUrl(raw);
    if (raw && !url) fail(`Invalid single server URL: ${raw}`);
    next.singleServerUrl = url;
  }

  if (!next.servers.some((s) => s.enabled) && next.mode === "multi") {
    fail("Enable at least one server for multi-server mode");
  }
  if (next.mode === "single" && !next.singleServerUrl) {
    fail("Pick the server to use in single-server mode");
  }
  return next;
}

async function updateServerSettings(body) {
  const current = await loadServerSettings({ fresh: true });
  const next = validateUpdate(body, current);
  const data = {
    mode: next.mode,
    servers: next.servers,
    singleServerUrl: next.singleServerUrl,
    strategy: next.strategy,
    downCooldownSeconds: next.downCooldownSeconds,
  };
  await ServerSettings.findOneAndUpdate(
    { singletonKey: "default" },
    { $set: data },
    { upsert: true, setDefaultsOnInsert: true },
  );
  cache = { at: 0, settings: null };
  return loadServerSettings({ fresh: true });
}

/** What clients receive: the servers they may use, in order. */
function toClientConfig(settings) {
  const serverUrls =
    settings.mode === "single"
      ? [settings.singleServerUrl].filter(Boolean)
      : settings.servers.filter((s) => s.enabled).map((s) => s.url);
  return {
    mode: settings.mode,
    serverUrls,
    strategy: settings.strategy,
    downCooldownSeconds: settings.downCooldownSeconds,
    updatedAt: settings.updatedAt,
  };
}

module.exports = {
  loadServerSettings,
  updateServerSettings,
  toClientConfig,
  normalizeUrl,
};
