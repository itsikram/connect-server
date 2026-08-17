/**
 * Chat Location Controller
 * Handles AI-powered natural language queries about friend locations
 */

const Profile = require("../models/Profile");
const {
  processLocationChatQuery,
  getFullFriendDetails,
} = require("../services/ai/chatLocationService");
const { translate } = require("../utils/localization/translations");

/**
 * POST /api/location/chat
 * AI Chat endpoint for natural language friend location queries
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
 * GET /api/location/friend-details/:friendId
 * Get complete friend details for chat display
 * Query params: lang (optional)
 *
 * Example: GET /api/location/friend-details/65f1a2b3c4d5e6f7g8h9i0j1?lang=bn
 */
exports.getFriendDetailsForChat = async (req, res, next) => {
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

    const details = await getFullFriendDetails(friendId, profileId, lang);

    return res.status(details.success ? 200 : 400).json(details);
  } catch (error) {
    console.error("Error in getFriendDetailsForChat:", error);
    next(error);
  }
};

/**
 * POST /api/location/bulk-friend-details
 * Get details for multiple friends at once
 * Body: { friendIds: [], lang }
 */
exports.getBulkFriendDetails = async (req, res, next) => {
  try {
    const { friendIds = [], lang = "eng" } = req.body;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    if (!Array.isArray(friendIds) || friendIds.length === 0) {
      return res.status(400).json({
        error: true,
        message:
          lang === "bn"
            ? "বন্ধু আইডির তালিকা প্রয়োজন।"
            : "Array of friend IDs is required.",
      });
    }

    const allDetails = [];

    for (const friendId of friendIds) {
      const details = await getFullFriendDetails(friendId, profileId, lang);
      if (details.success) {
        allDetails.push(details);
      }
    }

    return res.status(200).json({
      success: true,
      count: allDetails.length,
      friends: allDetails,
      language: lang,
    });
  } catch (error) {
    console.error("Error in getBulkFriendDetails:", error);
    next(error);
  }
};

/**
 * POST /api/location/chat-list-friends
 * Get a formatted list of all friends for chat display
 * Body: { latitude, longitude, lang }
 */
exports.getChatFriendsList = async (req, res, next) => {
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
      path: "friends",
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

    if (!userProfile || !userProfile.friends) {
      return res.status(200).json({
        success: true,
        friends: [],
        message:
          lang === "bn" ? "আপনার কোনো বন্ধু নেই।" : "You have no friends yet.",
      });
    }

    // Format friends data
    const friendsList = userProfile.friends
      .map((friend, index) => {
        let distanceInfo = null;

        if (friend.lastLocation) {
          const R = 6371;
          const dLat = (friend.lastLocation.latitude - lat) * (Math.PI / 180);
          const dLon = (friend.lastLocation.longitude - lon) * (Math.PI / 180);

          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat * (Math.PI / 180)) *
              Math.cos(friend.lastLocation.latitude * (Math.PI / 180)) *
              Math.sin(dLon / 2) *
              Math.sin(dLon / 2);

          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          const distance = R * c;

          distanceInfo = {
            distance: parseFloat(distance.toFixed(2)),
            latitude: friend.lastLocation.latitude,
            longitude: friend.lastLocation.longitude,
            hasLocation: true,
          };
        }

        return {
          index: index + 1,
          id: friend._id,
          name: friend.fullName || friend.displayName,
          profilePic: friend.profilePic,
          isActive: friend.isActive,
          address: friend.presentAddress || friend.permanentAddress,
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
        ? `👥 **আপনার ${friendsList.length} জন বন্ধু রয়েছে:**\n\n`
        : `👥 **You have ${friendsList.length} friends:**\n\n`;

    friendsList.forEach((friend, idx) => {
      message += `${idx + 1}. ${friend.emoji} **${friend.name}**\n`;
      if (friend.distance) {
        message +=
          lang === "bn"
            ? `   📍 ${friend.distance.distance} কিমি দূরে\n`
            : `   📍 ${friend.distance.distance} km away\n`;
      } else {
        message +=
          lang === "bn"
            ? `   ⚠️ অবস্থান শেয়ার করেননি\n`
            : `   ⚠️ Location not shared\n`;
      }
      if (friend.address) {
        message +=
          lang === "bn"
            ? `   📌 ${friend.address}\n`
            : `   📌 ${friend.address}\n`;
      }
      message += `   ${friend.isActive ? "🟢 সক্রিয়" : "🔴 অফলাইন"}\n\n`;
    });

    return res.status(200).json({
      success: true,
      message,
      friends: friendsList,
      total: friendsList.length,
      nearbyCount: friendsList.filter(
        (f) => f.distance && f.distance.distance <= 50,
      ).length,
      language: lang,
    });
  } catch (error) {
    console.error("Error in getChatFriendsList:", error);
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
