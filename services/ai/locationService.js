/**
 * AI-Powered Location Service
 * Handles friend location queries and analysis
 */

const Profile = require("../../models/Profile");
const {
  translate,
  getTranslations,
  translations,
} = require("../../utils/localization/translations");

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - User's latitude
 * @param {number} lon1 - User's longitude
 * @param {number} lat2 - Friend's latitude
 * @param {number} lon2 - Friend's longitude
 * @returns {number} - Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

/**
 * Get cardinal direction between two points
 * @param {number} lat1 - User's latitude
 * @param {number} lon1 - User's longitude
 * @param {number} lat2 - Friend's latitude
 * @param {number} lon2 - Friend's longitude
 * @returns {string} - Cardinal direction (N, S, E, W, NE, NW, SE, SW)
 */
function getDirection(lat1, lon1, lat2, lon2) {
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;

  let direction = "";

  // Vertical direction
  if (dLat > 0.05) direction += "N";
  else if (dLat < -0.05) direction += "S";

  // Horizontal direction
  if (dLon > 0.05) direction += "E";
  else if (dLon < -0.05) direction += "W";

  if (!direction) direction = "same_location";

  return direction;
}

/**
 * Map direction code to translation key
 * @param {string} directionCode - Direction code (N, S, E, W, etc.)
 * @param {string} lang - Language code
 * @returns {string} - Direction name
 */
function getDirectionName(directionCode, lang = "eng") {
  const directionMap = {
    N: "north",
    S: "south",
    E: "east",
    W: "west",
    NE: "northeast",
    NW: "northwest",
    SE: "southeast",
    SW: "southwest",
    same_location: "same location",
  };

  const key = directionMap[directionCode];
  if (key && translations[key]) {
    return translate(key, lang);
  }
  return directionCode;
}

/**
 * Categorize distance for messaging
 * @param {number} distance - Distance in kilometers
 * @param {string} name - Friend's name
 * @param {string} lang - Language code
 * @returns {object} - Category and message
 */
function categorizeDistance(distance, name, lang = "eng") {
  if (distance < 0.5) {
    return {
      category: "veryClose",
      message: translate("veryClose", lang, name, distance),
    };
  } else if (distance < 2) {
    return {
      category: "nearby",
      message: translate("nearby", lang, name, distance),
    };
  } else if (distance < 10) {
    return {
      category: "moderate",
      message: translate("moderate", lang, name, distance),
    };
  } else {
    return {
      category: "far",
      message: translate("far", lang, name, distance),
    };
  }
}

/**
 * Validate location coordinates
 * @param {number} latitude - Latitude
 * @param {number} longitude - Longitude
 * @returns {boolean} - True if valid
 */
function isValidLocation(latitude, longitude) {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Get friends' locations based on user's location
 * @param {object} userProfile - User's profile object
 * @param {number} latitude - User's latitude
 * @param {number} longitude - User's longitude
 * @param {object} options - Additional options
 * @returns {Promise<object>} - Location data with formatted response
 */
async function getFriendsLocations(
  userProfile,
  latitude,
  longitude,
  options = {},
) {
  const lang = options.lang || "eng";
  const radiusKm = options.radiusKm || 50; // Default 50 km radius

  // Validate coordinates
  if (!isValidLocation(latitude, longitude)) {
    throw {
      error: true,
      message: translate("invalidLocation", lang),
      code: "INVALID_LOCATION",
    };
  }

  // Check if user has friends
  if (!userProfile.friends || userProfile.friends.length === 0) {
    return {
      success: true,
      message: translate("noFriendsFound", lang),
      friends: [],
      summary: {
        total: 0,
        nearby: 0,
        withLocation: 0,
      },
    };
  }

  // Fetch friends with their location data
  const friendsData = await Profile.find({
    _id: { $in: userProfile.friends },
  })
    .select([
      "fullName",
      "displayName",
      "profilePic",
      "lastLocation",
      "presentAddress",
      "permanentAddress",
      "username",
    ])
    .populate({
      path: "user",
      select: ["firstName", "surname"],
    });

  // Process each friend's location
  const processedFriends = [];
  let friendsWithLocation = 0;
  let friendsNearby = 0;

  for (const friend of friendsData) {
    // Check if friend has location data
    if (
      !friend.lastLocation ||
      !isValidLocation(
        friend.lastLocation.latitude,
        friend.lastLocation.longitude,
      )
    ) {
      processedFriends.push({
        id: friend._id,
        name: friend.fullName || friend.displayName,
        username: friend.username,
        profilePic: friend.profilePic,
        distance: null,
        direction: null,
        hasLocation: false,
        message: translate(
          "noLocation",
          lang,
          friend.fullName || friend.displayName,
        ),
        address: friend.presentAddress || friend.permanentAddress,
      });
      continue;
    }

    friendsWithLocation++;

    // Calculate distance
    const distance = calculateDistance(
      latitude,
      longitude,
      friend.lastLocation.latitude,
      friend.lastLocation.longitude,
    );

    // Check if within radius
    if (distance <= radiusKm) {
      friendsNearby++;

      // Get direction
      const directionCode = getDirection(
        latitude,
        longitude,
        friend.lastLocation.latitude,
        friend.lastLocation.longitude,
      );
      const directionName = getDirectionName(directionCode, lang);

      // Categorize distance
      const distanceCategory = categorizeDistance(
        distance,
        friend.fullName || friend.displayName,
        lang,
      );

      processedFriends.push({
        id: friend._id,
        name: friend.fullName || friend.displayName,
        username: friend.username,
        profilePic: friend.profilePic,
        distance: parseFloat(distance.toFixed(2)),
        direction: directionName,
        directionCode: directionCode,
        category: distanceCategory.category,
        message: distanceCategory.message,
        address: friend.presentAddress || friend.permanentAddress,
        hasLocation: true,
        timestamp: friend.lastLocation.timestamp,
      });
    }
  }

  // Sort by distance
  processedFriends.sort((a, b) => {
    if (a.distance === null) return 1;
    if (b.distance === null) return -1;
    return a.distance - b.distance;
  });

  // Generate summary
  const summary = {
    total: userProfile.friends.length,
    nearby: friendsNearby,
    withLocation: friendsWithLocation,
    withoutLocation: userProfile.friends.length - friendsWithLocation,
    radius: radiusKm,
  };

  // Generate detailed response
  let detailedMessage = "";

  if (friendsNearby === 0) {
    if (friendsWithLocation === 0) {
      detailedMessage = translate("noFriendsWithLocation", lang);
    } else {
      detailedMessage = `${translate("friendsNearby", lang)} No friends within ${radiusKm} km.`;
    }
  } else {
    detailedMessage = translate("success", lang) + "\n";
    detailedMessage +=
      translate("totalFriendsNearby", lang, friendsNearby) + "\n\n";

    // Add details for each nearby friend
    processedFriends
      .filter((f) => f.distance !== null)
      .forEach((friend, index) => {
        detailedMessage += `${index + 1}. ${friend.name}\n`;
        detailedMessage += `   ${friend.message}\n`;
        if (friend.address) {
          detailedMessage += `   Address: ${friend.address}\n`;
        }
        detailedMessage += "\n";
      });
  }

  return {
    success: true,
    message: detailedMessage,
    friends: processedFriends,
    summary,
    metadata: {
      userLocation: { latitude, longitude },
      requestedAt: new Date(),
      language: lang,
    },
  };
}

/**
 * Get AI-formatted response for friend locations
 * @param {object} locationData - Data from getFriendsLocations
 * @param {string} lang - Language code
 * @returns {object} - AI-formatted response
 */
function formatAIResponse(locationData, lang = "eng") {
  if (!locationData.success) {
    return {
      success: false,
      message: locationData.message,
      error: true,
    };
  }

  const nearbyFriends = locationData.friends.filter((f) => f.distance !== null);

  return {
    success: true,
    greeting: translate("friendLocationInquiry", lang),
    summary: translate("summaryHeading", lang),
    totalFriendsWithLocation: locationData.summary.withLocation,
    totalNearby: locationData.summary.nearby,
    details: nearbyFriends.map((friend) => ({
      name: friend.name,
      distance: `${friend.distance} km`,
      direction: friend.direction,
      message: friend.message,
      address: friend.address || "Not shared",
    })),
    friendsWithoutLocation: locationData.friends.filter(
      (f) => f.distance === null,
    ).length,
    message: locationData.message,
  };
}

module.exports = {
  calculateDistance,
  getDirection,
  getDirectionName,
  categorizeDistance,
  isValidLocation,
  getFriendsLocations,
  formatAIResponse,
};
