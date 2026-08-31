/**
 * CPU-aware reverse proxy for Connect.
 *
 * Web / mobile talk to this process (default :4000).
 * API requests go to the healthiest backend (lowest process CPU).
 * Socket.IO and /ws/speech stay sticky so realtime connections do not bounce.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const http = require("http");
const httpProxy = require("http-proxy");

const LB_PORT = Number(process.env.LB_PORT || process.env.PORT || 4000);
const POLL_MS = Number(process.env.LB_POLL_MS || 1500);
const STICKY_COOKIE = "connect.lb";
const STICKY_MAX_AGE = 8 * 60 * 60;
const HEALTH_STALE_MS = 8000;

const parseServerList = (raw) =>
  String(raw || "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const defaultBackends = () => {
  const count = Number(process.env.LB_BACKENDS || 3);
  const start = Number(process.env.LB_BACKEND_START_PORT || 4001);
  return Array.from({ length: count }, (_, i) => `http://127.0.0.1:${start + i}`);
};

const backendUrls = parseServerList(process.env.BACKEND_SERVERS);
const urls = backendUrls.length ? backendUrls : defaultBackends();

const backends = urls.map((url) => ({
  id: url.replace(/^https?:\/\//, ""),
  url,
  healthy: false,
  cpu: 100,
  systemCpu: 100,
  sockets: 0,
  memoryRss: 0,
  inFlight: 0,
  lastError: null,
  sampledAt: 0,
}));

const stickyByClient = new Map();

const parseCookies = (header = "") => {
  const out = {};
  String(header)
    .split(";")
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx === -1) return;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) out[key] = decodeURIComponent(value);
    });
  return out;
};

const clientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress
    ? String(req.socket.remoteAddress)
    : "";
};

const requestPath = (req) => {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return req.url || "/";
  }
};

const isRealtimePath = (req) => {
  const pathname = requestPath(req);
  return (
    pathname === "/socket.io" ||
    pathname.startsWith("/socket.io/") ||
    pathname === "/ws/speech" ||
    pathname.startsWith("/ws/speech/")
  );
};

const isLbLocalPath = (req) => {
  const pathname = requestPath(req);
  return pathname === "/health" || pathname === "/lb/status";
};

const scoreBackend = (backend) =>
  backend.cpu +
  backend.systemCpu * 0.05 +
  backend.sockets * 0.08 +
  backend.inFlight * 6 +
  backend.memoryRss / (1024 * 1024 * 1024) * 4;

const isFresh = (backend) =>
  backend.healthy && Date.now() - backend.sampledAt < HEALTH_STALE_MS;

const findById = (id) => backends.find((item) => item.id === id);

const pickLowestCpu = () => {
  const fresh = backends.filter(isFresh);
  const pool = fresh.length ? fresh : backends;
  return pool.reduce((best, item) =>
    scoreBackend(item) < scoreBackend(best) ? item : best,
  );
};

const pickBackend = (req, { websocket = false } = {}) => {
  if (isRealtimePath(req) || websocket) {
    const cookies = parseCookies(req.headers.cookie);
    const stickyId = cookies[STICKY_COOKIE];
    const sticky = stickyId && findById(stickyId);
    if (sticky && isFresh(sticky)) return sticky;

    const key = `${clientIp(req)}|${req.headers["user-agent"] || ""}`;
    const rememberedId = stickyByClient.get(key);
    const remembered = rememberedId && findById(rememberedId);
    if (remembered && isFresh(remembered)) return remembered;

    const chosen = pickLowestCpu();
    stickyByClient.set(key, chosen.id);
    return chosen;
  }

  return pickLowestCpu();
};

const stickyCookieValue = (backend) =>
  `${STICKY_COOKIE}=${encodeURIComponent(backend.id)}; Path=/; Max-Age=${STICKY_MAX_AGE}; SameSite=Lax; HttpOnly`;

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const lbStatus = () => ({
  ok: backends.some(isFresh),
  role: "load-balancer",
  strategy: "least-cpu",
  port: LB_PORT,
  backends: backends.map((item) => ({
    id: item.id,
    url: item.url,
    healthy: isFresh(item),
    cpu: item.cpu,
    systemCpu: item.systemCpu,
    sockets: item.sockets,
    inFlight: item.inFlight,
    score: Math.round(scoreBackend(item) * 10) / 10,
    lastError: item.lastError,
    sampledAt: item.sampledAt,
  })),
});

const pollHealth = async (backend) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${backend.url}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    backend.healthy = true;
    backend.cpu = Number(data.cpu);
    if (!Number.isFinite(backend.cpu)) backend.cpu = 100;
    backend.systemCpu = Number(data.systemCpu) || 0;
    backend.sockets = Number(data.sockets) || 0;
    backend.memoryRss = Number(data.memory && data.memory.rss) || 0;
    backend.lastError = null;
    backend.sampledAt = Date.now();
  } catch (err) {
    backend.healthy = false;
    backend.cpu = 100;
    backend.lastError = err && err.message ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
};

const startHealthPolls = () => {
  const tick = () => Promise.all(backends.map(pollHealth));
  tick();
  setInterval(tick, POLL_MS).unref();
};

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  changeOrigin: false,
  proxyTimeout: 0,
  timeout: 0,
});

proxy.on("proxyReq", (proxyReq, req) => {
  proxyReq.setHeader("x-forwarded-proto", req.socket.encrypted ? "https" : "http");
});

proxy.on("proxyRes", (proxyRes, req) => {
  if (!isRealtimePath(req) || !req._lbBackend) return;
  const current = proxyRes.headers["set-cookie"];
  const next = stickyCookieValue(req._lbBackend);
  proxyRes.headers["set-cookie"] = current
    ? [].concat(current, next)
    : [next];
});

proxy.on("end", (req) => {
  if (req._lbBackend) req._lbBackend.inFlight = Math.max(0, req._lbBackend.inFlight - 1);
});

proxy.on("error", (err, req, res) => {
  if (req._lbBackend) {
    req._lbBackend.healthy = false;
    req._lbBackend.lastError = err && err.message ? err.message : String(err);
    req._lbBackend.inFlight = Math.max(0, req._lbBackend.inFlight - 1);
  }

  if (res && typeof res.writeHead === "function" && !res.headersSent) {
    json(res, 502, {
      ok: false,
      error: "Bad gateway",
      backend: req._lbBackend ? req._lbBackend.id : null,
    });
    return;
  }

  if (res && typeof res.destroy === "function") {
    try {
      res.destroy();
    } catch (_) {
      /* ignore */
    }
  }
});

const proxyTo = (req, res, backend) => {
  req._lbBackend = backend;
  backend.inFlight += 1;
  proxy.web(req, res, { target: backend.url });
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS" && isLbLocalPath(req)) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (isLbLocalPath(req)) {
    const status = lbStatus();
    json(res, status.ok ? 200 : 503, status);
    return;
  }

  const backend = pickBackend(req);
  proxyTo(req, res, backend);
});

server.on("upgrade", (req, socket, head) => {
  const backend = pickBackend(req, { websocket: true });
  req._lbBackend = backend;
  backend.inFlight += 1;
  socket.setNoDelay(true);
  socket.on("close", () => {
    backend.inFlight = Math.max(0, backend.inFlight - 1);
  });
  proxy.ws(req, socket, head, { target: backend.url });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

startHealthPolls();

server.listen(LB_PORT, "0.0.0.0", () => {
  console.log(`[lb] listening on ${LB_PORT}`);
  console.log(`[lb] CPU routing API to: ${backends.map((item) => item.url).join(", ")}`);
  console.log(`[lb] sticky sockets for /socket.io and /ws/speech`);
  console.log(`[lb] status: http://127.0.0.1:${LB_PORT}/lb/status`);
});
