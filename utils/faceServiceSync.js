const normalizeFaceServiceUrl = (raw) => {
  if (raw === undefined || raw === null) return "";
  const value = String(raw).trim().replace(/\/+$/, "");
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
};

const state = {
  url: normalizeFaceServiceUrl(process.env.FACE_SERVICE_URL || ""),
  source: process.env.FACE_SERVICE_URL ? "env" : "unset",
  updatedAt: process.env.FACE_SERVICE_URL ? new Date().toISOString() : null,
};

const getFaceServiceConfig = () => ({
  url: normalizeFaceServiceUrl(process.env.FACE_SERVICE_URL || state.url || ""),
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
  return { ok: true, changed, ...getFaceServiceConfig() };
};

module.exports = { normalizeFaceServiceUrl, getFaceServiceConfig, applyFaceServiceUrl };
