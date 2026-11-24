// Real-time expression detection through this server.
//
// The face service (face-login, Python) runs on cPanel shared hosting, where
// Passenger serves one plain HTTP request at a time per process: Socket.IO
// cannot work there. Clients already speak Socket.IO to `<face url>/expressions`,
// so this server hosts that namespace itself and forwards each frame to the
// face service's POST /api/expression/analyze with the server-only API key.
// Clients then send `emotion_change` on their main, signed-in socket as before.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const DEFAULT_FACE_API_URL = "https://mystorefrontsigns.com/face-api";
const TOKEN_PURPOSE = "expressions";
const TOKEN_TTL = "7d";
// Same cap as the face service: about 12 frames per second per socket.
const MIN_FRAME_INTERVAL_MS = 80;
const MAX_IMAGE_CHARS = 3 * 1024 * 1024;
const ANALYZE_TIMEOUT_MS = 8000;

const normalizeUrl = (value) => String(value || "").trim().replace(/\/+$/, "");

const isBridgeEnabled = () =>
  !["0", "false", "no", "off"].includes(
    String(process.env.FACE_EXPRESSION_BRIDGE ?? "1").trim().toLowerCase(),
  );

/** Base URL of the hosted face service (face login and expression analysis). */
const getFaceApiUrl = () => normalizeUrl(process.env.FACE_ANALYZE_URL) || DEFAULT_FACE_API_URL;

// A key derived from the login secret, so an expression token can never be
// accepted as a login token or the other way round.
const tokenSecret = () => {
  const base = String(process.env.JWT_SECRET_KEY || "");
  return base ? crypto.createHmac("sha256", base).update("expression-socket-v1").digest("hex") : "";
};

/** A token for the /expressions namespace, handed to signed-in users only. */
const issueExpressionToken = (userId) => {
  const secret = tokenSecret();
  if (!secret) return "";
  return jwt.sign({ purpose: TOKEN_PURPOSE, sub: String(userId || "") }, secret, {
    expiresIn: TOKEN_TTL,
  });
};

const verifyExpressionToken = (token) => {
  const secret = tokenSecret();
  if (!secret || !token) return null;
  try {
    const decoded = jwt.verify(String(token), secret);
    return decoded && decoded.purpose === TOKEN_PURPOSE ? decoded : null;
  } catch {
    return null;
  }
};

/** Public origin of this server as the client reached it. */
const publicOriginOf = (req) => {
  const configured = normalizeUrl(process.env.PUBLIC_SERVER_URL);
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}` : "";
};

const isTimeout = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";

const callFaceApi = async (fetchImpl, body) => {
  const request = () =>
    fetchImpl(`${getFaceApiUrl()}/api/expression/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Face-Service-Key": String(process.env.FACE_SERVICE_API_KEY || ""),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
    });
  let response;
  try {
    response = await request();
  } catch (error) {
    // Apache on the face host closes idle keep-alive connections after a
    // few seconds; the first frame after a pause can hit a closed socket.
    // Retry that once on a fresh connection, but never a timeout.
    if (isTimeout(error)) throw error;
    response = await request();
  }
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
};

/**
 * Reachability and key check for the hosted face service, without a frame.
 * Returns { enabled, url, reachable, authorized, status, ms }.
 */
const checkFaceApi = async (fetchImpl = fetch) => {
  const startedAt = Date.now();
  const result = { enabled: isBridgeEnabled(), url: getFaceApiUrl() };
  try {
    const { status } = await callFaceApi(fetchImpl, { sessionId: "status-check", end: true });
    return { ...result, reachable: true, authorized: status === 200, status, ms: Date.now() - startedAt };
  } catch (error) {
    return { ...result, reachable: false, authorized: false, error: error?.message, ms: Date.now() - startedAt };
  }
};

function attachExpressionBridge(io, { fetchImpl = fetch, log = console } = {}) {
  const namespace = io.of("/expressions");

  namespace.use((socket, next) => {
    if (!isBridgeEnabled()) return next(new Error("expression bridge disabled"));
    const decoded = verifyExpressionToken(socket.handshake.auth?.token);
    if (!decoded) return next(new Error("unauthorized"));
    socket.data.userId = decoded.sub || null;
    return next();
  });

  namespace.on("connection", (socket) => {
    let inFlight = false;
    let lastFrameAt = 0;
    let frames = 0;

    socket.on("frame", async (payload) => {
      const now = Date.now();
      if (inFlight || now - lastFrameAt < MIN_FRAME_INTERVAL_MS) {
        // Clients wait for a reply before capturing the next frame.
        socket.emit("expression_skipped", { reason: "busy" });
        return;
      }
      const image = payload && typeof payload === "object" ? payload.image : null;
      if (typeof image !== "string" || !image || image.length > MAX_IMAGE_CHARS) {
        socket.emit("expression_error", { message: "frame image must be a base64 string" });
        return;
      }
      inFlight = true;
      lastFrameAt = now;
      try {
        const { ok, status, data } = await callFaceApi(fetchImpl, { sessionId: socket.id, image });
        if (ok) {
          frames += 1;
          // This server does not broadcast on the client's behalf; the client
          // sends emotion_change on its own signed-in socket.
          socket.emit("expression_update", { ...data, connect_relayed: false });
        } else if (status === 429) {
          socket.emit("expression_skipped", { reason: "busy" });
        } else {
          if (status >= 500 || status === 401 || status === 403) {
            log.warn("[expression_bridge] face service error", { status, message: data?.message });
          }
          socket.emit("expression_error", {
            message: data?.message || `face service returned HTTP ${status}`,
          });
        }
      } catch (error) {
        log.warn("[expression_bridge] face service unreachable", { message: error?.message });
        socket.emit("expression_error", { message: "face service unavailable" });
      } finally {
        inFlight = false;
      }
    });

    socket.on("disconnect", () => {
      if (!frames) return;
      // Free the face service's smoothing state for this socket.
      callFaceApi(fetchImpl, { sessionId: socket.id, end: true }).catch(() => {});
    });
  });

  return namespace;
}

module.exports = {
  attachExpressionBridge,
  checkFaceApi,
  getFaceApiUrl,
  isBridgeEnabled,
  issueExpressionToken,
  publicOriginOf,
  verifyExpressionToken,
};
