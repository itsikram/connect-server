const { Adapter } = require("socket.io-adapter");

const INTERNAL_PATH = "/__internal/socket-broadcast";

const getInternalSecret = () =>
  process.env.LB_INTERNAL_SECRET ||
  process.env.JWT_SECRET ||
  "connect-local-lb";

const normalizeUrl = (value = "") => String(value).trim().replace(/\/+$/, "");

const getSelfUrl = () =>
  normalizeUrl(
    process.env.INSTANCE_URL ||
      `http://127.0.0.1:${process.env.PORT || 4000}`,
  );

const getPeerUrls = () => {
  const self = getSelfUrl();
  const raw = process.env.PEER_SERVERS || "";
  return raw
    .split(",")
    .map((item) => normalizeUrl(item))
    .filter((item) => item && item !== self);
};

const toArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return [];
};

const publishToPeers = (payload) => {
  const peers = getPeerUrls();
  if (!peers.length) return;

  const body = JSON.stringify(payload);
  const secret = getInternalSecret();

  for (const peer of peers) {
    fetch(`${peer}${INTERNAL_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-connect-internal-secret": secret,
      },
      body,
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      // Peer may be restarting; local emit already happened.
    });
  }
};

class HttpPeerAdapter extends Adapter {
  broadcast(packet, opts = {}) {
    super.broadcast(packet, opts);
    if (opts.flags && opts.flags.local) return;

    publishToPeers({
      nsp: this.nsp.name,
      packet,
      opts: {
        rooms: toArray(opts.rooms),
        except: toArray(opts.except),
        flags: { ...(opts.flags || {}), local: true },
      },
    });
  }
}

const attachPeerAdapter = (io) => {
  if (!getPeerUrls().length) {
    return false;
  }
  io.adapter(HttpPeerAdapter);
  console.log(
    `[sockets] peer adapter enabled for ${getPeerUrls().length} sibling server(s)`,
  );
  return true;
};

const attachPeerRelayRoute = (app, io) => {
  if (!getPeerUrls().length) return;

  const secret = getInternalSecret();
  app.post(INTERNAL_PATH, (req, res) => {
    if (req.get("x-connect-internal-secret") !== secret) {
      return res.status(403).json({ ok: false });
    }

    const nspName = req.body && req.body.nsp;
    const packet = req.body && req.body.packet;
    const opts = (req.body && req.body.opts) || {};
    const nsp = io.of(nspName || "/");
    if (!nsp || !packet) {
      return res.status(400).json({ ok: false });
    }

    nsp.adapter.broadcast(packet, {
      rooms: new Set(toArray(opts.rooms)),
      except: new Set(toArray(opts.except)),
      flags: { ...(opts.flags || {}), local: true },
    });
    return res.json({ ok: true });
  });
};

module.exports = {
  INTERNAL_PATH,
  attachPeerAdapter,
  attachPeerRelayRoute,
};
