const fs = require("fs");
const path = require("path");

// Tunnel URL of the Expo control daemon on the home PC, published by
// home-cobalt/expo-control-tunnel-sync.js (same flow as faceServiceSync).
const runtimeFile = path.join(__dirname, "..", ".expo-control-url.json");
// The home worker re-publishes every 5 minutes; after this long without a
// sync the PC is probably off or the tunnel is down.
const STALE_AFTER_MS = 12 * 60 * 1000;

const normalizeUrl = (raw) => String(raw || "").trim().replace(/\/+$/, "");

const readPersisted = () => {
  try {
    if (!fs.existsSync(runtimeFile)) return {};
    return JSON.parse(fs.readFileSync(runtimeFile, "utf8")) || {};
  } catch (error) {
    console.warn("[expo-control-sync] unable to read persisted URL:", error.message);
    return {};
  }
};

const persisted = readPersisted();
const state = {
  url: normalizeUrl(process.env.EXPO_CONTROL_URL || persisted.url || ""),
  source: process.env.EXPO_CONTROL_URL ? "env" : persisted.source || "unset",
  updatedAt: persisted.updatedAt || null,
  lastSyncAt: persisted.lastSyncAt || null,
};

const getExpoControlConfig = () => {
  const lastSyncMs = state.lastSyncAt ? Date.parse(state.lastSyncAt) : 0;
  return {
    url: state.url,
    source: state.source,
    updatedAt: state.updatedAt,
    lastSyncAt: state.lastSyncAt,
    online: Boolean(state.url) && (state.source === "env" || Date.now() - lastSyncMs < STALE_AFTER_MS),
  };
};

const applyExpoControlUrl = (rawUrl, source = "remote") => {
  const url = normalizeUrl(rawUrl);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Expo control URL must be a valid HTTPS URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Expo control URL must use HTTPS" };
  }
  const now = new Date().toISOString();
  const changed = state.url !== url;
  state.url = url;
  state.source = source;
  state.lastSyncAt = now;
  if (changed || !state.updatedAt) state.updatedAt = now;
  try {
    fs.writeFileSync(runtimeFile, JSON.stringify(state), "utf8");
  } catch (error) {
    console.warn("[expo-control-sync] unable to persist URL:", error.message);
  }
  return { ok: true, changed, ...getExpoControlConfig() };
};

module.exports = { getExpoControlConfig, applyExpoControlUrl };
