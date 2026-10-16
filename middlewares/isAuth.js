const jwt = require("jsonwebtoken");
const { prisma, populated, pluck } = require("../utils/db");
const cache = require("../utils/cache");

const SECRET_KEY = process.env.JWT_SECRET_KEY;

/**
 * Profile of a user with `user` populated, plus the `connects` / `blockedUsers`
 * id arrays that other modules still read from req.profile (they were arrays
 * on the Mongoose document; now they come from the join tables).
 */
const readAuthProfile = async (userId) => {
  const row = await prisma.profile.findFirst({
    where: { user: String(userId) },
    include: {
      userDoc: true,
      connects: { select: { connect: true } },
      blockedUsers: { select: { blocked: true } },
    },
  });
  if (!row) return null;
  populated(row, "user");
  row.connects = pluck(row.connects, "connect");
  row.blockedUsers = pluck(row.blockedUsers, "blocked");
  return row;
};

// Every authenticated request needs this profile; keep it for 30s. Any write
// to these tables (profile edit, connect, block...) drops it at once.
const AUTH_PROFILE_TTL_MS = 30 * 1000;
const AUTH_PROFILE_TAGS = ["Profile", "User", "ProfileConnect", "Block"];

// Deep copy of a Prisma row (reads the computed `_id` getters, keeps Dates).
const copyRow = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(copyRow);
  const out = {};
  for (const key of Object.keys(value)) out[key] = copyRow(value[key]);
  if ("_id" in value && !("_id" in out)) out._id = value._id;
  return out;
};

const loadAuthProfile = async (userId) => {
  if (!userId) return null;
  const row = await cache.wrap(`auth:${userId}`, AUTH_PROFILE_TTL_MS, AUTH_PROFILE_TAGS, () =>
    readAuthProfile(userId),
  );
  // A copy per request: handlers may modify req.profile.
  return row ? copyRow(row) : null;
};

// Online status allows 5 minutes of silence, so write presence (isActive,
// lastActive, lastLogin, location) at most once a minute per user instead of
// on every request.
const PRESENCE_WRITE_INTERVAL_MS = 60 * 1000;
const lastPresenceWrite = new Map();

const shouldWritePresence = (profileId) => {
  const now = Date.now();
  if (now - (lastPresenceWrite.get(profileId) || 0) < PRESENCE_WRITE_INTERVAL_MS) return false;
  lastPresenceWrite.set(profileId, now);
  if (lastPresenceWrite.size > 50000) lastPresenceWrite.clear();
  return true;
};

let isAuth = async (req, res, next) => {
  try {
    let token = req.headers.authorization;

    // Check if token exists
    if (!token) {
      return res.status(401).json({
        message: "Authentication token is required",
      });
    }

    let { user_id } = jwt.verify(token, SECRET_KEY);
    let profileData = await loadAuthProfile(user_id);
    if (!profileData) {
      return res.status(401).json({
        message: "You are not a authenticated User",
      });
    }

    // Build the status/location update payload
    const updateData = { isActive: true, lastActive: new Date() };

    const latitude = req.headers["x-latitude"] || req.body?.latitude;
    const longitude = req.headers["x-longitude"] || req.body?.longitude;
    const locationAccuracy =
      req.headers["x-location-accuracy"] ||
      req.body?.locationAccuracy ||
      req.body?.accuracy;

    if (latitude && longitude) {
      updateData.lastLocation = {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        timestamp: Date.now(),
        ...(locationAccuracy && { accuracy: parseFloat(locationAccuracy) }),
      };
    }

    // Fire-and-forget: these status writes don't need to block the request.
    if (shouldWritePresence(profileData.id)) {
      prisma.profile
        .update({ where: { id: profileData.id }, data: updateData })
        .catch(() => {});
      prisma.user
        .updateMany({ where: { id: String(user_id) }, data: { lastLogin: Date.now() } })
        .catch(() => {});
    }

    req.profile = profileData;
    next();
  } catch (error) {
    // Handle JWT verification errors
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError"
    ) {
      return res.status(401).json({
        message: "Invalid or expired token",
      });
    }
    next(error);
  }
};

isAuth.loadAuthProfile = loadAuthProfile;

module.exports = isAuth;
