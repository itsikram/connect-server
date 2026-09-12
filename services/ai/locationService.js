/**
 * AI-Powered Location Service
 * Handles connect location queries and analysis
 */

const Profile = require("../../models/Profile");
const Relationship = require("../../models/Relationship");
const {
  translate,
  getTranslations,
  translations,
} = require("../../utils/localization/translations");

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - User's latitude
 * @param {number} lon1 - User's longitude
 * @param {number} lat2 - Connect's latitude
 * @param {number} lon2 - Connect's longitude
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
 * @param {number} lat2 - Connect's latitude
 * @param {number} lon2 - Connect's longitude
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
 * @param {string} name - Connect's name
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
 * Get connects' locations based on user's location
 * @param {object} userProfile - User's profile object
 * @param {number} latitude - User's latitude
 * @param {number} longitude - User's longitude
 * @param {object} options - Additional options
 * @returns {Promise<object>} - Location data with formatted response
 */
async function getConnectsLocations(
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

  // Check if user has connects
  if (!userProfile.connects || userProfile.connects.length === 0) {
    return {
      success: true,
      message: translate("noConnectsFound", lang),
      connects: [],
      summary: {
        total: 0,
        nearby: 0,
        withLocation: 0,
      },
    };
  }

  // Fetch connects with their location data
  const connectsData = await Profile.find({
    _id: { $in: userProfile.connects },
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

  const relationshipRows = await Relationship.find({
    $or: [
      { userA: userProfile._id, userB: { $in: userProfile.connects } },
      { userB: userProfile._id, userA: { $in: userProfile.connects } },
    ],
  }).select("userA userB relationType");
  const relationshipMap = new Map();
  relationshipRows.forEach((row) => {
    const otherId = String(row.userA) === String(userProfile._id)
      ? String(row.userB)
      : String(row.userA);
    const types = relationshipMap.get(otherId) || [];
    if (!types.includes(row.relationType)) types.push(row.relationType);
    relationshipMap.set(otherId, types);
  });

  // Process each connect's location
  const processedConnects = [];
  let connectsWithLocation = 0;
  let connectsNearby = 0;

  for (const connect of connectsData) {
    const relationshipTypes = relationshipMap.get(String(connect._id)) || [];
    // Check if connect has location data
    if (
      !connect.lastLocation ||
      !isValidLocation(
        connect.lastLocation.latitude,
        connect.lastLocation.longitude,
      )
    ) {
      processedConnects.push({
        id: connect._id,
        name: connect.fullName || connect.displayName,
        username: connect.username,
        profilePic: connect.profilePic,
        distance: null,
        direction: null,
        hasLocation: false,
        message: translate(
          "noLocation",
          lang,
          connect.fullName || connect.displayName,
        ),
        address: connect.presentAddress || connect.permanentAddress,
        relationshipTypes,
      });
      continue;
    }

    connectsWithLocation++;

    // Calculate distance
    const distance = calculateDistance(
      latitude,
      longitude,
      connect.lastLocation.latitude,
      connect.lastLocation.longitude,
    );

    // Check if within radius
    if (distance <= radiusKm) {
      connectsNearby++;

      // Get direction
      const directionCode = getDirection(
        latitude,
        longitude,
        connect.lastLocation.latitude,
        connect.lastLocation.longitude,
      );
      const directionName = getDirectionName(directionCode, lang);

      // Categorize distance
      const distanceCategory = categorizeDistance(
        distance,
        connect.fullName || connect.displayName,
        lang,
      );

      processedConnects.push({
        id: connect._id,
        name: connect.fullName || connect.displayName,
        username: connect.username,
        profilePic: connect.profilePic,
        distance: parseFloat(distance.toFixed(2)),
        direction: directionName,
        directionCode: directionCode,
        category: distanceCategory.category,
        message: distanceCategory.message,
        address: connect.presentAddress || connect.permanentAddress,
        hasLocation: true,
        timestamp: connect.lastLocation.timestamp,
        relationshipTypes,
      });
    }
  }

  // Sort by distance
  processedConnects.sort((a, b) => {
    if (a.distance === null) return 1;
    if (b.distance === null) return -1;
    return a.distance - b.distance;
  });

  // Generate summary
  const summary = {
    total: userProfile.connects.length,
    nearby: connectsNearby,
    withLocation: connectsWithLocation,
    withoutLocation: userProfile.connects.length - connectsWithLocation,
    radius: radiusKm,
  };

  // Generate detailed response
  let detailedMessage = "";

  if (connectsNearby === 0) {
    if (connectsWithLocation === 0) {
      detailedMessage = translate("noConnectsWithLocation", lang);
    } else {
      detailedMessage = `${translate("connectsNearby", lang)} No connects within ${radiusKm} km.`;
    }
  } else {
    detailedMessage = translate("success", lang) + "\n";
    detailedMessage +=
      translate("totalConnectsNearby", lang, connectsNearby) + "\n\n";

    // Add details for each nearby connect
    processedConnects
      .filter((f) => f.distance !== null)
      .forEach((connect, index) => {
        detailedMessage += `${index + 1}. ${connect.name}\n`;
        detailedMessage += `   ${connect.message}\n`;
        if (connect.address) {
          detailedMessage += `   Address: ${connect.address}\n`;
        }
        detailedMessage += "\n";
      });
  }

  return {
    success: true,
    message: detailedMessage,
    connects: processedConnects,
    summary,
    metadata: {
      userLocation: { latitude, longitude },
      requestedAt: new Date(),
      language: lang,
    },
  };
}

/**
 * Get AI-formatted response for connect locations
 * @param {object} locationData - Data from getConnectsLocations
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

  const nearbyConnects = locationData.connects.filter((f) => f.distance !== null);

  return {
    success: true,
    greeting: translate("connectLocationInquiry", lang),
    summary: translate("summaryHeading", lang),
    totalConnectsWithLocation: locationData.summary.withLocation,
    totalNearby: locationData.summary.nearby,
    details: nearbyConnects.map((connect) => ({
      name: connect.name,
      distance: `${connect.distance} km`,
      direction: connect.direction,
      message: connect.message,
      address: connect.address || "Not shared",
    })),
    connectsWithoutLocation: locationData.connects.filter(
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
  getConnectsLocations,
  formatAIResponse,
};
