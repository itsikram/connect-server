/**
 * AI Chat Location Service
 * Handles natural language queries about connect locations
 * Provides detailed conversational responses
 */

const Profile = require("../../models/Profile");
const {
  calculateDistance,
  getDirection,
  getDirectionName,
  categorizeDistance,
  isValidLocation,
  getConnectsLocations,
} = require("./locationService");
const { translate } = require("../../utils/localization/translations");

/**
 * Parse natural language queries
 * @param {string} query - User's natural language query
 * @returns {object} - Parsed query intent and parameters
 */
function parseLocationQuery(query) {
  const lowerQuery = query.toLowerCase();

  return {
    type: determineQueryType(lowerQuery),
    hasDistance: determineDistancePreference(lowerQuery),
    isSingleConnect: isSingleConnectQuery(lowerQuery),
    needsDirection:
      lowerQuery.includes("direction") || lowerQuery.includes("where"),
    needsAddress:
      lowerQuery.includes("address") || lowerQuery.includes("location"),
    tone: determineTone(lowerQuery),
    language: detectLanguage(query),
  };
}

/**
 * Determine query type
 */
function determineQueryType(query) {
  if (
    query.includes("close") ||
    query.includes("near") ||
    query.includes("nearby")
  ) {
    return "nearby";
  } else if (query.includes("far") || query.includes("distant")) {
    return "far";
  } else if (query.includes("all") || query.includes("everyone")) {
    return "all";
  } else if (
    query.includes("connect") &&
    (query.includes("where") || query.includes("location"))
  ) {
    return "connect_location";
  } else {
    return "general";
  }
}

/**
 * Determine distance preference
 */
function determineDistancePreference(query) {
  if (query.includes("very close") || query.includes("extremely close")) {
    return 0.5;
  } else if (query.includes("close") || query.includes("near")) {
    return 2;
  } else if (query.includes("moderate") || query.includes("medium")) {
    return 10;
  } else if (query.includes("far") || query.includes("distant")) {
    return 100;
  }
  return 50; // Default
}

/**
 * Check if query is about single connect
 */
function isSingleConnectQuery(query) {
  return (
    query.includes("where is ") ||
    query.includes("where's ") ||
    query.includes("location of ")
  );
}

/**
 * Determine tone/style of response
 */
function determineTone(query) {
  if (query.includes("?") && query.includes("!")) return "enthusiastic";
  if (query.includes("!!") || query.includes("???")) return "enthusiastic";
  if (query.includes("please") || query.includes("help")) return "polite";
  return "connectly";
}

/**
 * Detect if query contains Bengali or English
 */
function detectLanguage(query) {
  // Simple detection based on Bengali Unicode range
  const bengaliRegex = /[\u0980-\u09FF]/g;
  const bengaliChars = (query.match(bengaliRegex) || []).length;

  if (bengaliChars > query.length * 0.3) {
    return "bn";
  }
  return "eng";
}

/**
 * Build detailed chat response
 */
function buildDetailedResponse(locationData, lang = "eng") {
  const nearbyConnects = locationData.connects.filter((f) => f.distance !== null);
  const connectsWithoutLocation = locationData.connects.filter(
    (f) => f.distance === null,
  );

  let response = "";

  // Greeting
  response += getGreeting(nearbyConnects.length, lang) + "\n\n";

  // Summary
  if (nearbyConnects.length > 0) {
    response += getSummary(locationData.summary, lang) + "\n\n";

    // Detailed connect information
    response += getConnectsDetails(nearbyConnects, lang) + "\n\n";
  } else {
    response +=
      getNoConnectsMessage(connectsWithoutLocation.length, lang) + "\n\n";
  }

  // Helpful suggestions
  if (nearbyConnects.length > 0) {
    response += getSuggestions(nearbyConnects, lang);
  }

  return response;
}

/**
 * Generate greeting message
 */
function getGreeting(connectCount, lang = "eng") {
  if (connectCount === 0) {
    return lang === "bn"
      ? "আপনার অবস্থানের কাছে কোনো বন্ধু নেই। তবে আপনার বন্ধুদের তালিকা দেখে আমি আপনাকে সাহায্য করতে পারি।"
      : "I couldn't find any connects nearby at your location, but I can help you with your connects' information.";
  }

  if (connectCount === 1) {
    return lang === "bn"
      ? "দুর্দান্ত! আমি আপনার কাছে ১ জন বন্ধু খুঁজে পেয়েছি। এখানে বিস্তারিত তথ্য রয়েছে:"
      : "Great! I found 1 connect near you. Here are the details:";
  }

  return lang === "bn"
    ? `চমৎকার! আমি আপনার কাছে ${connectCount} জন বন্ধু খুঁজে পেয়েছি। এখানে সবার বিস্তারিত তথ্য রয়েছে:`
    : `Excellent! I found ${connectCount} connects near you. Here are the details for everyone:`;
}

/**
 * Generate summary message
 */
function getSummary(summary, lang = "eng") {
  return lang === "bn"
    ? `📊 **সংক্ষিপ্ত বিবরণ:**\n- মোট বন্ধু: ${summary.total}\n- ${summary.radius} কিমির মধ্যে কাছাকাছি: ${summary.nearby}\n- অবস্থান শেয়ার করেছেন: ${summary.withLocation}`
    : `📊 **Summary:**\n- Total Connects: ${summary.total}\n- Nearby (within ${summary.radius} km): ${summary.nearby}\n- Shared Location: ${summary.withLocation}`;
}

/**
 * Generate detailed connect information
 */
function getConnectsDetails(connects, lang = "eng") {
  let details =
    lang === "bn"
      ? "👥 **কাছাকাছি বন্ধুদের বিস্তারিত:**\n\n"
      : "👥 **Nearby Connects Details:**\n\n";

  connects.forEach((connect, index) => {
    const emoji =
      index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "📍";

    details += `${emoji} **${connect.name}**\n`;
    if (connect.relationshipTypes?.length) {
      details +=
        lang === "bn"
          ? `   🤝 সম্পর্ক: ${connect.relationshipTypes.join(", ")}\n`
          : `   🤝 Relationship: ${connect.relationshipTypes.join(", ")}\n`;
    }

    if (connect.distance !== null) {
      details +=
        lang === "bn"
          ? `   📏 দূরত্ব: ${connect.distance.toFixed(2)} কিমি\n`
          : `   📏 Distance: ${connect.distance.toFixed(2)} km\n`;

      details +=
        lang === "bn"
          ? `   🧭 দিক: ${connect.direction}\n`
          : `   🧭 Direction: ${connect.direction}\n`;

      if (connect.address) {
        details +=
          lang === "bn"
            ? `   📍 ঠিকানা: ${connect.address}\n`
            : `   📍 Address: ${connect.address}\n`;
      }

      details +=
        lang === "bn"
          ? `   ℹ️ বর্ণনা: ${connect.message}\n`
          : `   ℹ️ Info: ${connect.message}\n`;
    }

    details += "\n";
  });

  return details;
}

/**
 * Generate message when no connects are nearby
 */
function getNoConnectsMessage(totalConnects, lang = "eng") {
  if (totalConnects === 0) {
    return lang === "bn"
      ? "❌ কোনো বন্ধু এখনও তাদের অবস্থান শেয়ার করেননি। তাদের অবস্থান শেয়ার করতে বলুন!"
      : "❌ None of your connects have shared their location yet. Ask them to share their location!";
  }

  return lang === "bn"
    ? `⚠️ আপনার ${totalConnects} জন বন্ধু দূরে রয়েছেন।`
    : `⚠️ Your ${totalConnects} connects are too far away.`;
}

/**
 * Generate helpful suggestions
 */
function getSuggestions(connects, lang = "eng") {
  let suggestions =
    lang === "bn"
      ? "💡 **সহায়ক পরামর্শ:**\n"
      : "💡 **Helpful Suggestions:**\n";

  const closest = connects[0];
  suggestions +=
    lang === "bn"
      ? `✓ আপনার সবচেয়ে কাছের বন্ধু হল ${closest.name} (${closest.distance.toFixed(2)} কিমি দূরে)\n`
      : `✓ Your closest connect is ${closest.name} (${closest.distance.toFixed(2)} km away)\n`;

  if (connects.length > 1) {
    const average = (
      connects.reduce((sum, f) => sum + f.distance, 0) / connects.length
    ).toFixed(2);
    suggestions +=
      lang === "bn"
        ? `✓ গড় দূরত্ব: ${average} কিমি\n`
        : `✓ Average distance: ${average} km\n`;
  }

  suggestions +=
    lang === "bn"
      ? `✓ আপনি বন্ধুদের সাথে দেখা করতে পারেন!\n`
      : `✓ You can meet up with your connects!\n`;

  return suggestions;
}

/**
 * Chat endpoint handler - Main AI response builder
 */
async function processLocationChatQuery(
  userProfile,
  latitude,
  longitude,
  query,
  lang = "eng",
) {
  try {
    // Validate location
    if (!isValidLocation(latitude, longitude)) {
      return {
        success: false,
        error: true,
        message:
          lang === "bn"
            ? "❌ অবৈধ অবস্থান স্থানাঙ্ক দেওয়া হয়েছে।"
            : "❌ Invalid location coordinates provided.",
      };
    }

    // Parse the query to understand intent
    const parsedQuery = parseLocationQuery(query);

    // Determine radius based on query
    let radiusKm = 50;
    if (
      parsedQuery.hasDistance &&
      typeof parsedQuery.hasDistance === "number"
    ) {
      radiusKm = parsedQuery.hasDistance;
    }

    // Get location data
    const locationData = await getConnectsLocations(
      userProfile,
      latitude,
      longitude,
      {
        lang,
        radiusKm,
      },
    );

    // If query is about specific connect, handle differently
    if (parsedQuery.isSingleConnect && query.includes("where")) {
      return buildSingleConnectResponse(locationData, query, lang);
    }

    // Build detailed chat response
    const detailedResponse = buildDetailedResponse(locationData, lang);

    // Add timestamp and metadata
    return {
      success: true,
      message: detailedResponse,
      queryType: parsedQuery.type,
      connectsFound: locationData.connects.filter((f) => f.distance !== null)
        .length,
      totalConnects: locationData.summary.total,
      timestamp: new Date(),
      language: lang,
      metadata: {
        queryParsed: {
          type: parsedQuery.type,
          tone: parsedQuery.tone,
          distance: parsedQuery.hasDistance,
        },
        locationData: locationData.summary,
      },
    };
  } catch (error) {
    console.error("Error in processLocationChatQuery:", error);
    return {
      success: false,
      error: true,
      message:
        lang === "bn"
          ? "❌ অনুরোধ প্রক্রিয়া করতে একটি ত্রুটি ঘটেছে।"
          : "❌ An error occurred while processing your request.",
      errorDetails: error.message,
    };
  }
}

/**
 * Build response for single connect query
 */
function buildSingleConnectResponse(locationData, query, lang = "eng") {
  // Extract connect name from query
  const connects = locationData.connects.filter((f) => f.distance !== null);

  if (connects.length === 0) {
    return {
      success: true,
      message:
        lang === "bn"
          ? "কোনো বন্ধু আপনার কাছাকাছি নেই বা তাদের অবস্থান শেয়ার করেননি।"
          : "No connects are near you or have shared their location.",
      connectsFound: 0,
    };
  }

  let response =
    lang === "bn"
      ? "🔍 **আপনার বন্ধুদের অবস্থান তথ্য:**\n\n"
      : "🔍 **Your Connects' Location Information:**\n\n";

  connects.forEach((connect) => {
    response += `📍 **${connect.name}**\n`;
    response +=
      lang === "bn"
        ? `   • দূরত্ব: ${connect.distance.toFixed(2)} কিমি\n`
        : `   • Distance: ${connect.distance.toFixed(2)} km\n`;
    response +=
      lang === "bn"
        ? `   • দিক: ${connect.direction}\n`
        : `   • Direction: ${connect.direction}\n`;
    if (connect.address) {
      response +=
        lang === "bn"
          ? `   • ঠিকানা: ${connect.address}\n`
          : `   • Address: ${connect.address}\n`;
    }
    response += "\n";
  });

  return {
    success: true,
    message: response,
    connectsFound: connects.length,
  };
}

/**
 * Get full connect details for chat display
 */
async function getFullConnectDetails(connectId, userProfileId, lang = "eng") {
  try {
    const userProfile = await Profile.findById(userProfileId);

    if (!userProfile || !userProfile.connects.includes(connectId)) {
      return {
        success: false,
        message:
          lang === "bn"
            ? "এই বন্ধু আপনার বন্ধু তালিকায় নেই।"
            : "This connect is not in your connects list.",
      };
    }

    const connect = await Profile.findById(connectId)
      .populate("user", ["firstName", "surname", "email"])
      .select([
        "fullName",
        "displayName",
        "username",
        "profilePic",
        "bio",
        "lastLocation",
        "presentAddress",
        "permanentAddress",
        "workPlaces",
        "schools",
        "isActive",
        "lastEmotion",
        "lastEmotionText",
      ]);

    if (!connect) {
      return {
        success: false,
        message:
          lang === "bn"
            ? "বন্ধু প্রোফাইল খুঁজে পাওয়া যায়নি।"
            : "Connect profile not found.",
      };
    }

    // Format detailed response
    let details =
      lang === "bn"
        ? `👤 **${connect.fullName} এর সম্পূর্ণ তথ্য:**\n\n`
        : `👤 **Complete Information about ${connect.fullName}:**\n\n`;

    details += lang === "bn" ? `**ব্যক্তিগত তথ্য:**\n` : `**Personal Info:**\n`;
    details +=
      lang === "bn"
        ? `   • ডিসপ্লে নাম: ${connect.displayName || "-"}\n`
        : `   • Display Name: ${connect.displayName || "-"}\n`;
    details +=
      lang === "bn"
        ? `   • ইউজারনেম: ${connect.username || "-"}\n`
        : `   • Username: ${connect.username || "-"}\n`;
    details +=
      lang === "bn"
        ? `   • ইমেইল: ${connect.user?.email || "-"}\n`
        : `   • Email: ${connect.user?.email || "-"}\n`;
    details +=
      lang === "bn"
        ? `   • বায়ো: ${connect.bio || "-"}\n`
        : `   • Bio: ${connect.bio || "-"}\n`;

    if (connect.lastLocation) {
      details += lang === "bn" ? `\n**অবস্থান:**\n` : `\n**Location:**\n`;
      details +=
        lang === "bn"
          ? `   • অক্ষাংশ: ${connect.lastLocation.latitude}\n`
          : `   • Latitude: ${connect.lastLocation.latitude}\n`;
      details +=
        lang === "bn"
          ? `   • দ্রাঘিমাংশ: ${connect.lastLocation.longitude}\n`
          : `   • Longitude: ${connect.lastLocation.longitude}\n`;
    }

    if (connect.presentAddress || connect.permanentAddress) {
      details += lang === "bn" ? `\n**ঠিকানা:**\n` : `\n**Addresses:**\n`;
      if (connect.presentAddress) {
        details +=
          lang === "bn"
            ? `   • বর্তমান: ${connect.presentAddress}\n`
            : `   • Present: ${connect.presentAddress}\n`;
      }
      if (connect.permanentAddress) {
        details +=
          lang === "bn"
            ? `   • স্থায়ী: ${connect.permanentAddress}\n`
            : `   • Permanent: ${connect.permanentAddress}\n`;
      }
    }

    if (connect.workPlaces && connect.workPlaces.length > 0) {
      details += lang === "bn" ? `\n**কর্মক্ষেত্র:**\n` : `\n**Workplaces:**\n`;
      connect.workPlaces.forEach((work) => {
        details +=
          lang === "bn"
            ? `   • ${work.company || "-"} (${work.position || "-"})\n`
            : `   • ${work.company || "-"} (${work.position || "-"})\n`;
      });
    }

    if (connect.schools && connect.schools.length > 0) {
      details +=
        lang === "bn" ? `\n**শিক্ষা প্রতিষ্ঠান:**\n` : `\n**Schools:**\n`;
      connect.schools.forEach((school) => {
        details +=
          lang === "bn"
            ? `   • ${school.name || "-"} (${school.degree || "-"})\n`
            : `   • ${school.name || "-"} (${school.degree || "-"})\n`;
      });
    }

    details += lang === "bn" ? `\n**স্থিতি:**\n` : `\n**Status:**\n`;
    details +=
      lang === "bn"
        ? `   • সক্রিয়: ${connect.isActive ? "হ্যাঁ ✓" : "না"}\n`
        : `   • Active: ${connect.isActive ? "Yes ✓" : "No"}\n`;

    if (connect.lastEmotion) {
      details +=
        lang === "bn"
          ? `   • মেজাজ: ${connect.lastEmotionText || connect.lastEmotion}\n`
          : `   • Mood: ${connect.lastEmotionText || connect.lastEmotion}\n`;
    }

    return {
      success: true,
      message: details,
      connect: {
        id: connect._id,
        name: connect.fullName,
        profilePic: connect.profilePic,
        isActive: connect.isActive,
      },
    };
  } catch (error) {
    console.error("Error in getFullConnectDetails:", error);
    return {
      success: false,
      message:
        lang === "bn"
          ? "বন্ধুর তথ্য সংগ্রহে ত্রুটি ঘটেছে।"
          : "Error retrieving connect details.",
      error: error.message,
    };
  }
}

module.exports = {
  parseLocationQuery,
  processLocationChatQuery,
  buildDetailedResponse,
  getFullConnectDetails,
};
