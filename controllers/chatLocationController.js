/**
 * Chat Location Controller
 * Handles AI-powered natural language queries about connect locations
 */

const Profile = require("../models/Profile");
const {
  processLocationChatQuery,
  getFullConnectDetails,
} = require("../services/ai/chatLocationService");
const { translate } = require("../utils/localization/translations");

/**
 * POST /api/location/chat
 * AI Chat endpoint for natural language connect location queries
 * Body: { latitude, longitude, message, lang }
 *
 * Example: POST /api/location/chat
 * {
 *   "latitude": 23.8103,
 *   "longitude": 90.4125,
 *   "message": "আমার পাশে কে কে আছে?",
 *   "lang": "bn"
 * }
 */
exports.chatLocationQuery = async (req, res, next) => {
  try {
    const { latitude, longitude, message, lang = "eng" } = req.body;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    if (latitude === undefined || longitude === undefined || !message) {
      return res.status(400).json({
        error: true,
        message:
          lang === "bn"
            ? "অবস্থান স্থানাঙ্ক এবং বার্তা প্রয়োজন।"
            : "Location coordinates and message are required.",
        required: ["latitude", "longitude", "message"],
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

    if (!["eng", "bn"].includes(lang)) {
      return res.status(400).json({
        error: true,
        message: `Invalid language. Use 'eng' or 'bn'`,
      });
    }

    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    // Update user's location
    await Profile.findByIdAndUpdate(profileId, {
      lastLocation: {
        latitude: lat,
        longitude: lon,
        timestamp: new Date(),
      },
    });

    // Process the chat query
    const chatResponse = await processLocationChatQuery(
      userProfile,
      lat,
      lon,
      message,
      lang,
    );

    return res.status(200).json(chatResponse);
  } catch (error) {
    console.error("Error in chatLocationQuery:", error);
    next(error);
  }
};

/**
 * GET /api/location/connect-details/:connectId
 * Get complete connect details for chat display
 * Query params: lang (optional)
 *
 * Example: GET /api/location/connect-details/65f1a2b3c4d5e6f7g8h9i0j1?lang=bn
 */
exports.getConnectDetailsForChat = async (req, res, next) => {
  try {
    const { lang = "eng" } = req.query;
    const { connectId } = req.params;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const details = await getFullConnectDetails(connectId, profileId, lang);

    return res.status(details.success ? 200 : 400).json(details);
  } catch (error) {
    console.error("Error in getConnectDetailsForChat:", error);
    next(error);
  }
};

/**
 * POST /api/location/bulk-connect-details
 * Get details for multiple connects at once
 * Body: { connectIds: [], lang }
 */
exports.getBulkConnectDetails = async (req, res, next) => {
  try {
    const { connectIds = [], lang = "eng" } = req.body;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    if (!Array.isArray(connectIds) || connectIds.length === 0) {
      return res.status(400).json({
        error: true,
        message:
          lang === "bn"
            ? "বন্ধু আইডির তালিকা প্রয়োজন।"
            : "Array of connect IDs is required.",
      });
    }

    const allDetails = [];

    for (const connectId of connectIds) {
      const details = await getFullConnectDetails(connectId, profileId, lang);
      if (details.success) {
        allDetails.push(details);
      }
    }

    return res.status(200).json({
      success: true,
      count: allDetails.length,
      connects: allDetails,
      language: lang,
    });
  } catch (error) {
    console.error("Error in getBulkConnectDetails:", error);
    next(error);
  }
};

/**
 * POST /api/location/chat-list-connects
 * Get a formatted list of all connects for chat display
 * Body: { latitude, longitude, lang }
 */
exports.getChatConnectsList = async (req, res, next) => {
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

    const userProfile = await Profile.findById(profileId).populate({
      path: "connects",
      select: [
        "_id",
        "fullName",
        "displayName",
        "profilePic",
        "lastLocation",
        "presentAddress",
        "permanentAddress",
        "isActive",
      ],
    });

    if (!userProfile || !userProfile.connects) {
      return res.status(200).json({
        success: true,
        connects: [],
        message:
          lang === "bn" ? "আপনার কোনো বন্ধু নেই।" : "You have no connects yet.",
      });
    }

    // Format connects data
    const connectsList = userProfile.connects
      .map((connect, index) => {
        let distanceInfo = null;

        if (connect.lastLocation) {
          const R = 6371;
          const dLat = (connect.lastLocation.latitude - lat) * (Math.PI / 180);
          const dLon = (connect.lastLocation.longitude - lon) * (Math.PI / 180);

          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat * (Math.PI / 180)) *
              Math.cos(connect.lastLocation.latitude * (Math.PI / 180)) *
              Math.sin(dLon / 2) *
              Math.sin(dLon / 2);

          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          const distance = R * c;

          distanceInfo = {
            distance: parseFloat(distance.toFixed(2)),
            latitude: connect.lastLocation.latitude,
            longitude: connect.lastLocation.longitude,
            hasLocation: true,
          };
        }

        return {
          index: index + 1,
          id: connect._id,
          name: connect.fullName || connect.displayName,
          profilePic: connect.profilePic,
          isActive: connect.isActive,
          address: connect.presentAddress || connect.permanentAddress,
          distance: distanceInfo,
          emoji: getEmojiForDistance(distanceInfo),
        };
      })
      .sort((a, b) => {
        if (!a.distance && !b.distance) return 0;
        if (!a.distance) return 1;
        if (!b.distance) return 1;
        return a.distance.distance - b.distance.distance;
      });

    // Generate chat message
    let message =
      lang === "bn"
        ? `👥 **আপনার ${connectsList.length} জন বন্ধু রয়েছে:**\n\n`
        : `👥 **You have ${connectsList.length} connects:**\n\n`;

    connectsList.forEach((connect, idx) => {
      message += `${idx + 1}. ${connect.emoji} **${connect.name}**\n`;
      if (connect.distance) {
        message +=
          lang === "bn"
            ? `   📍 ${connect.distance.distance} কিমি দূরে\n`
            : `   📍 ${connect.distance.distance} km away\n`;
      } else {
        message +=
          lang === "bn"
            ? `   ⚠️ অবস্থান শেয়ার করেননি\n`
            : `   ⚠️ Location not shared\n`;
      }
      if (connect.address) {
        message +=
          lang === "bn"
            ? `   📌 ${connect.address}\n`
            : `   📌 ${connect.address}\n`;
      }
      message += `   ${connect.isActive ? "🟢 সক্রিয়" : "🔴 অফলাইন"}\n\n`;
    });

    return res.status(200).json({
      success: true,
      message,
      connects: connectsList,
      total: connectsList.length,
      nearbyCount: connectsList.filter(
        (f) => f.distance && f.distance.distance <= 50,
      ).length,
      language: lang,
    });
  } catch (error) {
    console.error("Error in getChatConnectsList:", error);
    next(error);
  }
};

/**
 * Helper function to get emoji based on distance
 */
function getEmojiForDistance(distanceInfo) {
  if (!distanceInfo) return "❓";

  const distance = distanceInfo.distance;

  if (distance < 0.5) return "🔴"; // Very close
  if (distance < 2) return "🟠"; // Close
  if (distance < 10) return "🟡"; // Nearby
  if (distance < 50) return "🟢"; // Moderate
  return "🔵"; // Far
}

// Exports are already defined with exports.functionName above
