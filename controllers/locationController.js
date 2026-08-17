/**
 * Location Controller
 * Handles friend location queries and AI responses
 */

const Profile = require("../models/Profile");
const {
  getFriendsLocations,
  formatAIResponse,
} = require("../services/ai/locationService");
const { translate } = require("../utils/localization/translations");

/**
 * GET /api/location/friends-nearby
 * Get friends nearby based on user's location coordinates
 * Query params: latitude, longitude, lang (optional - 'eng' or 'bn'), radius (optional)
 */
exports.getFriendsNearby = async (req, res, next) => {
  try {
    const { latitude, longitude, lang = "eng", radius = 50 } = req.query;
    const profileId = req.profile?._id;

    // Validate required parameters
    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
        code: "UNAUTHORIZED",
      });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
        code: "MISSING_COORDINATES",
        required: ["latitude", "longitude"],
      });
    }

    // Parse coordinates to numbers
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const radiusKm = parseFloat(radius) || 50;

    // Validate coordinates
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
        code: "INVALID_COORDINATES",
      });
    }

    // Validate language
    if (!["eng", "bn"].includes(lang)) {
      return res.status(400).json({
        error: true,
        message: `Invalid language. Use 'eng' or 'bn'`,
        code: "INVALID_LANGUAGE",
      });
    }

    // Get user profile
    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
        code: "PROFILE_NOT_FOUND",
      });
    }

    // Update user's current location (for real-time tracking)
    await Profile.findByIdAndUpdate(profileId, {
      lastLocation: {
        latitude: lat,
        longitude: lon,
        timestamp: new Date(),
      },
    });

    // Get friends locations
    const locationData = await getFriendsLocations(userProfile, lat, lon, {
      lang,
      radiusKm,
    });

    // Format as AI response
    const aiResponse = formatAIResponse(locationData, lang);

    return res.status(200).json(aiResponse);
  } catch (error) {
    console.error("Error in getFriendsNearby:", error);
    next(error);
  }
};

/**
 * GET /api/location/friends-location-raw
 * Get raw friends location data (for map display)
 * Query params: latitude, longitude, lang (optional)
 */
exports.getFriendsLocationRaw = async (req, res, next) => {
  try {
    const { latitude, longitude, lang = "eng" } = req.query;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    const locationData = await getFriendsLocations(userProfile, lat, lon, {
      lang,
      radiusKm: 100, // Larger radius for raw data
    });

    return res.status(200).json({
      success: true,
      friends: locationData.friends.map((friend) => ({
        id: friend.id,
        name: friend.name,
        latitude: friend.lastLocation?.latitude,
        longitude: friend.lastLocation?.longitude,
        distance: friend.distance,
        profilePic: friend.profilePic,
      })),
      userLocation: { latitude: lat, longitude: lon },
    });
  } catch (error) {
    console.error("Error in getFriendsLocationRaw:", error);
    next(error);
  }
};

/**
 * POST /api/location/share-location
 * Update user's current location
 * Body: { latitude, longitude }
 */
exports.shareLocation = async (req, res, next) => {
  try {
    const { latitude, longitude, lang = "eng" } = req.body;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    // Validate latitude and longitude ranges
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    const updatedProfile = await Profile.findByIdAndUpdate(
      profileId,
      {
        lastLocation: {
          latitude: lat,
          longitude: lon,
          timestamp: new Date(),
        },
      },
      { new: true },
    );

    return res.status(200).json({
      success: true,
      message:
        lang === "bn"
          ? "আপনার অবস্থান সফলভাবে আপডেট হয়েছে।"
          : "Your location has been updated successfully.",
      location: updatedProfile.lastLocation,
    });
  } catch (error) {
    console.error("Error in shareLocation:", error);
    next(error);
  }
};

/**
 * GET /api/location/friend/:friendId
 * Get specific friend's location
 * Query params: lang (optional)
 */
exports.getFriendLocation = async (req, res, next) => {
  try {
    const { lang = "eng" } = req.query;
    const { friendId } = req.params;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    // Check if friend exists and is in user's friend list
    const userProfile = await Profile.findById(profileId);
    if (!userProfile || !userProfile.friends.includes(friendId)) {
      return res.status(403).json({
        error: true,
        message:
          lang === "bn"
            ? "এই বন্ধুটি আপনার বন্ধু তালিকায় নেই।"
            : "This friend is not in your friends list.",
        code: "NOT_FRIEND",
      });
    }

    const friendProfile = await Profile.findById(friendId).select([
      "fullName",
      "displayName",
      "lastLocation",
      "presentAddress",
      "permanentAddress",
      "profilePic",
    ]);

    if (!friendProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    if (!friendProfile.lastLocation) {
      return res.status(200).json({
        success: true,
        friend: {
          name: friendProfile.fullName,
          hasLocation: false,
          message:
            lang === "bn"
              ? "এই বন্ধু তাদের অবস্থান শেয়ার করেননি।"
              : "This friend has not shared their location.",
        },
      });
    }

    return res.status(200).json({
      success: true,
      friend: {
        name: friendProfile.fullName,
        hasLocation: true,
        location: friendProfile.lastLocation,
        address: friendProfile.presentAddress || friendProfile.permanentAddress,
        profilePic: friendProfile.profilePic,
      },
    });
  } catch (error) {
    console.error("Error in getFriendLocation:", error);
    next(error);
  }
};

/**
 * POST /api/location/search-nearby
 * AI-powered search for nearby friends
 * Body: { latitude, longitude, query, lang }
 */
exports.searchNearby = async (req, res, next) => {
  try {
    const { latitude, longitude, query, lang = "eng" } = req.body;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    // Parse natural language query (simple implementation)
    let radiusKm = 50;
    if (query) {
      if (
        query.toLowerCase().includes("close") ||
        query.toLowerCase().includes("near")
      ) {
        radiusKm = 5;
      } else if (
        query.toLowerCase().includes("very") &&
        query.toLowerCase().includes("close")
      ) {
        radiusKm = 1;
      } else if (
        query.toLowerCase().includes("far") ||
        query.toLowerCase().includes("distant")
      ) {
        radiusKm = 100;
      }
    }

    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    const locationData = await getFriendsLocations(userProfile, lat, lon, {
      lang,
      radiusKm,
    });

    const aiResponse = formatAIResponse(locationData, lang);

    return res.status(200).json({
      ...aiResponse,
      query: query || "nearby friends",
      radiusUsed: radiusKm,
    });
  } catch (error) {
    console.error("Error in searchNearby:", error);
    next(error);
  }
};
