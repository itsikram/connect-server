const fs = require("fs");
const path = require("path");

const normalizeFaceServiceUrl = (raw) => {
  if (raw === undefined || raw === null) return "";
  const value = String(raw).trim().replace(/\/+$/, "");
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
};

const runtimeFile = path.join(__dirname, "..", ".face-service-url.json");

const readPersistedUrl = () => {
  try {
    if (!fs.existsSync(runtimeFile)) return "";
    const parsed = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    return normalizeFaceServiceUrl(parsed?.url || "");
  } catch (error) {
    console.warn("[face-sync] unable to read persisted face URL:", error.message);
    return "";
  }
};

const state = {
  url: normalizeFaceServiceUrl(process.env.FACE_SERVICE_URL || "") || readPersistedUrl(),
  source: process.env.FACE_SERVICE_URL ? "env" : "unset",
  updatedAt: process.env.FACE_SERVICE_URL || readPersistedUrl() ? new Date().toISOString() : null,
};

const getFaceServiceConfig = () => ({
  url: normalizeFaceServiceUrl(process.env.FACE_SERVICE_URL || state.url || readPersistedUrl() || ""),
  source: state.source,
  updatedAt: state.updatedAt,
});

const applyFaceServiceUrl = (rawUrl, source = "remote") => {
  const url = normalizeFaceServiceUrl(rawUrl);
  if (!url) return { ok: false, error: "Missing face service URL", url: "" };
  const changed = state.url !== url || process.env.FACE_SERVICE_URL !== url;
  state.url = url;
  state.source = source;
  state.updatedAt = new Date().toISOString();
  process.env.FACE_SERVICE_URL = url;
  fs.writeFileSync(runtimeFile, JSON.stringify({
    url,
    source,
    updatedAt: state.updatedAt,
  }), "utf8");
  return { ok: true, changed, ...getFaceServiceConfig() };
};

module.exports = { normalizeFaceServiceUrl, getFaceServiceConfig, applyFaceServiceUrl };
