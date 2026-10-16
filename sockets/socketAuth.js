// Who is on the other end of a socket. Clients send the same access token the
// REST API uses (handshake `auth.token`); the profile it belongs to becomes the
// socket's identity (`socket.data.profileId`), and a `profile` id sent in the
// query is never trusted over it.
//
// SOCKET_AUTH_MODE:
//   grace (default)  sockets without a valid token keep the old behaviour (the
//                    claimed `profile` id), so app builds from before tokens
//                    were sent keep working. Each such profile is logged once.
//   strict           a claimed profile without a valid token is refused
//                    (connect_error "unauthorized", err.data.code set).
// Sockets that claim no profile at all connect anonymously in both modes.

const jwt = require("jsonwebtoken");

const clean = (value) => {
  const id = value == null ? "" : String(value).trim();
  return id && id !== "null" && id !== "undefined" ? id : "";
};

const claimedProfileOf = (socket) => {
  const { query = {}, auth = {} } = socket.handshake || {};
  return clean(query.profile || auth.profile || auth.profileId || query.profileId);
};

const tokenOf = (socket) => {
  const { query = {}, auth = {}, headers = {} } = socket.handshake || {};
  const raw = clean(auth.token || query.token || headers.authorization);
  return raw.replace(/^Bearer\s+/i, "");
};

const reasonOf = (error) => {
  if (error?.code === "unavailable") return "unavailable";
  if (error?.name === "TokenExpiredError") return "expired";
  return "invalid";
};

/**
 * verifyToken(token) -> user id (throws when invalid)
 * loadProfileId(userId) -> profile id or null (throws { code: "unavailable" }
 *                          when the database can't answer)
 */
function createSocketAuth({
  verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET_KEY).user_id,
  loadProfileId = defaultLoadProfileId,
  mode = () => String(process.env.SOCKET_AUTH_MODE || "grace").toLowerCase(),
  log = (message, data) => console.warn(message, data),
} = {}) {
  const graceLogged = new Set();

  const middleware = async (socket, next) => {
    socket.data = socket.data || {};
    const claimed = claimedProfileOf(socket);
    const token = tokenOf(socket);
    let reason = token ? null : "missing";

    if (token) {
      try {
        const profileId = clean(await loadProfileId(verifyToken(token)));
        if (profileId) {
          if (claimed && claimed !== profileId) {
            log("[socket-auth] claimed profile ignored; using the token's", { claimed, profileId });
          }
          socket.data.profileId = profileId;
          socket.data.authenticated = true;
          return next();
        }
        reason = "no_profile";
      } catch (error) {
        reason = reasonOf(error);
      }
    }

    if (!claimed) {
      socket.data.profileId = null;
      socket.data.authenticated = false;
      return next();
    }

    if (mode() === "strict") {
      const error = new Error("unauthorized");
      error.data = { code: reason === "unavailable" ? "unavailable" : "unauthorized", reason };
      return next(error);
    }

    if (!graceLogged.has(claimed)) {
      if (graceLogged.size > 10000) graceLogged.clear();
      graceLogged.add(claimed);
      log("[socket-auth] unverified socket allowed (SOCKET_AUTH_MODE=grace)", { profileId: claimed, reason });
    }
    socket.data.profileId = claimed;
    socket.data.authenticated = false;
    return next();
  };

  return { middleware };
}

async function defaultLoadProfileId(userId) {
  const { isMySQLReady } = require("../config/prisma");
  if (!isMySQLReady()) {
    const error = new Error("database unavailable");
    error.code = "unavailable";
    throw error;
  }
  const isAuth = require("../middlewares/isAuth");
  try {
    const profile = await isAuth.loadAuthProfile(userId);
    return profile ? String(profile.id || profile._id) : null;
  } catch (cause) {
    const error = new Error("database unavailable");
    error.code = "unavailable";
    error.cause = cause;
    throw error;
  }
}

/** The verified (or, in grace mode, claimed) profile of a connected socket. */
const profileIdOf = (socket) => {
  if (socket?.data && "profileId" in socket.data) return socket.data.profileId || null;
  return claimedProfileOf(socket) || null;
};

module.exports = { createSocketAuth, profileIdOf, claimedProfileOf, tokenOf };
