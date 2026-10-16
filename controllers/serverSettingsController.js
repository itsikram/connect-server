const axios = require("axios");
const {
  loadServerSettings,
  updateServerSettings,
  toClientConfig,
  normalizeUrl,
} = require("../utils/serverSettingsStore");

const HEALTH_TIMEOUT_MS = 15000;
const MAX_HEALTH_CHECKS = 20;

/** Public: the server list the web and Expo clients should use. */
exports.getClientServerConfig = async (req, res) => {
  const settings = await loadServerSettings();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(toClientConfig(settings));
};

exports.getAdminServerSettings = async (req, res) => {
  try {
    const settings = await loadServerSettings({ fresh: true });
    return res.status(200).json({ ...settings, clientConfig: toClientConfig(settings) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.updateAdminServerSettings = async (req, res) => {
  try {
    const settings = await updateServerSettings(req.body || {});
    const clientConfig = toClientConfig(settings);
    // Connected clients pick the new list up without waiting for their next refresh.
    req.app.get("io")?.emit("server-config-changed", clientConfig);
    return res.status(200).json({ ...settings, clientConfig });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

/** Pings each server's public config endpoint and reports reachability and latency. */
exports.checkAdminServers = async (req, res) => {
  const requested = Array.isArray(req.body?.urls) ? req.body.urls : null;
  const settings = await loadServerSettings();
  const urls = [
    ...new Set(
      (requested || [
        ...settings.servers.map((s) => s.url),
        settings.singleServerUrl,
      ])
        .map(normalizeUrl)
        .filter(Boolean),
    ),
  ].slice(0, MAX_HEALTH_CHECKS);

  const results = await Promise.all(
    urls.map(async (url) => {
      const started = Date.now();
      try {
        const response = await axios.get(`${url}/api/connect/server-config`, {
          timeout: HEALTH_TIMEOUT_MS,
          validateStatus: () => true,
          maxRedirects: 0,
        });
        return {
          url,
          // Any answer below 500 means the server is up.
          ok: response.status < 500,
          // False when the server runs an older build without this endpoint.
          hasServerConfig: response.status >= 200 && response.status < 300,
          status: response.status,
          ms: Date.now() - started,
        };
      } catch (error) {
        return {
          url,
          ok: false,
          status: null,
          ms: Date.now() - started,
          error: error.code === "ECONNABORTED" ? "timed out" : error.message,
        };
      }
    }),
  );
  return res.status(200).json({ results });
};
