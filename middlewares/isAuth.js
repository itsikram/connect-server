const jwt = require("jsonwebtoken");
const { prisma, populated, pluck } = require("../utils/db");

const SECRET_KEY = process.env.JWT_SECRET_KEY;

/**
 * Profile of a user with `user` populated, plus the `connects` / `blockedUsers`
 * id arrays that other modules still read from req.profile (they were arrays
 * on the Mongoose document; now they come from the join tables).
 */
const loadAuthProfile = async (userId) => {
  if (!userId) return null;
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
    prisma.profile
      .update({ where: { id: profileData.id }, data: updateData })
      .catch(() => {});
    prisma.user
      .updateMany({ where: { id: String(user_id) }, data: { lastLogin: Date.now() } })
      .catch(() => {});

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
