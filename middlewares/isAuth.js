const jwt = require("jsonwebtoken");
const Profile = require("../models/Profile");
const User = require("../models/User");

const SECRET_KEY = process.env.JWT_SECRET_KEY;

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
    let profileData = await Profile.findOne({ user: user_id }).populate("user");
    if (!profileData) {
      return res.status(401).json({
        message: "You are not a authenticated User",
      });
    }

    // Build the status/location update payload
    const updateData = { isActive: true };

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
    // Awaiting them was responsible for 3 extra serial DB round-trips per request.
    Profile.findByIdAndUpdate(profileData._id, updateData).catch(() => {});
    User.findByIdAndUpdate(user_id, { lastLogin: Date.now() }).catch(() => {});

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

module.exports = isAuth;
