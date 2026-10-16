// Several API servers can run behind the load balancer (PEER_SERVERS). Sockets
// stick to one server, but the players of one game may sit on different ones,
// so every game has exactly one owner server that runs it. The owner is a
// stable hash of the game id over the server list; other servers forward the
// game's actions to it over HTTP. State broadcasts already reach every server
// through the peer socket adapter (utils/peerSocketAdapter.js).

const crypto = require("crypto");

const INTERNAL_PATH = "/__internal/ludo";
const FORWARD_TIMEOUT_MS = 6000;

const normalizeUrl = (value = "") => String(value).trim().replace(/\/+$/, "");

const getSecret = () =>
  process.env.LB_INTERNAL_SECRET || process.env.JWT_SECRET || "connect-local-lb";

const selfUrl = () =>
  normalizeUrl(process.env.INSTANCE_URL || `http://127.0.0.1:${process.env.PORT || 4000}`);

const peerUrls = () => {
  const self = selfUrl();
  return String(process.env.PEER_SERVERS || "")
    .split(",")
    .map(normalizeUrl)
    .filter((url) => url && url !== self);
};

const allUrls = () => [...new Set([selfUrl(), ...peerUrls()])].sort();

const ownerOf = (gameId) => {
  const urls = allUrls();
  if (urls.length <= 1) return selfUrl();
  const digest = crypto.createHash("sha1").update(String(gameId)).digest();
  return urls[digest.readUInt32BE(0) % urls.length];
};

const post = async (url, body) => {
  try {
    const response = await fetch(`${url}${INTERNAL_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-connect-internal-secret": getSecret(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, error: "unavailable", message: "Game server unavailable. Retrying…" };
    return await response.json();
  } catch (_e) {
    return { ok: false, error: "unavailable", message: "Game server unavailable. Retrying…" };
  }
};

function createCluster(host) {
  const isLocal = (gameId) => ownerOf(gameId) === selfUrl();

  /** Runs a game action on the server that owns the game. */
  const call = (gameId, action, profileId, payload = {}, ctx = {}) => {
    if (!gameId || isLocal(gameId)) return host.handle(action, profileId, payload, ctx);
    return post(ownerOf(gameId), { action, gameId, profileId, payload, ctx });
  };

  /** Runs a per-player query on every server and returns each answer. */
  const callAll = async (action, profileId, payload = {}) => {
    const local = host.handle(action, profileId, payload, {});
    const remote = peerUrls().map((url) => post(url, { action, profileId, payload, ctx: {} }));
    return Promise.all([local, ...remote]);
  };

  /** A fresh game id this server owns, so creating a game never forwards. */
  const newLocalGameId = () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const id = host.newGameId();
      if (isLocal(id)) return id;
    }
    return host.newGameId();
  };

  const attachRoute = (app) => {
    if (!app || peerUrls().length === 0) return;
    app.post(INTERNAL_PATH, async (req, res) => {
      if (req.get("x-connect-internal-secret") !== getSecret()) {
        return res.status(403).json({ ok: false, error: "forbidden" });
      }
      const { action, profileId, payload, ctx } = req.body || {};
      const result = await host.handle(String(action || ""), profileId, payload || {}, ctx || {});
      return res.json(result);
    });
  };

  return { call, callAll, newLocalGameId, attachRoute, isLocal, ownerOf };
}

module.exports = { createCluster, ownerOf, selfUrl, peerUrls, INTERNAL_PATH };
