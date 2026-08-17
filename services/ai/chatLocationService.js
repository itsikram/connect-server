/**
 * AI Chat Location Service
 * Handles natural language queries about friend locations
 * Provides detailed conversational responses
 */

const Profile = require("../../models/Profile");
const {
  calculateDistance,
  getDirection,
  getDirectionName,
  categorizeDistance,
  isValidLocation,
  getFriendsLocations,
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
    isSingleFriend: isSingleFriendQuery(lowerQuery),
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
    query.includes("friend") &&
    (query.includes("where") || query.includes("location"))
  ) {
    return "friend_location";
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
 * Check if query is about single friend
 */
function isSingleFriendQuery(query) {
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
  return "friendly";
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
  const nearbyFriends = locationData.friends.filter((f) => f.distance !== null);
  const friendsWithoutLocation = locationData.friends.filter(
    (f) => f.distance === null,
  );

  let response = "";

  // Greeting
  response += getGreeting(nearbyFriends.length, lang) + "\n\n";

  // Summary
  if (nearbyFriends.length > 0) {
    response += getSummary(locationData.summary, lang) + "\n\n";

    // Detailed friend information
    response += getFriendsDetails(nearbyFriends, lang) + "\n\n";
  } else {
    response +=
      getNoFriendsMessage(friendsWithoutLocation.length, lang) + "\n\n";
  }

  // Helpful suggestions
  if (nearbyFriends.length > 0) {
    response += getSuggestions(nearbyFriends, lang);
  }

  return response;
}

/**
 * Generate greeting message
 */
function getGreeting(friendCount, lang = "eng") {
  if (friendCount === 0) {
    return lang === "bn"
      ? "আপনার অবস্থানের কাছে কোনো বন্ধু নেই। তবে আপনার বন্ধুদের তালিকা দেখে আমি আপনাকে সাহায্য করতে পারি।"
      : "I couldn't find any friends nearby at your location, but I can help you with your friends' information.";
  }

  if (friendCount === 1) {
    return lang === "bn"
      ? "দুর্দান্ত! আমি আপনার কাছে ১ জন বন্ধু খুঁজে পেয়েছি। এখানে বিস্তারিত তথ্য রয়েছে:"
      : "Great! I found 1 friend near you. Here are the details:";
  }

  return lang === "bn"
    ? `চমৎকার! আমি আপনার কাছে ${friendCount} জন বন্ধু খুঁজে পেয়েছি। এখানে সবার বিস্তারিত তথ্য রয়েছে:`
    : `Excellent! I found ${friendCount} friends near you. Here are the details for everyone:`;
}

/**
 * Generate summary message
 */
function getSummary(summary, lang = "eng") {
  return lang === "bn"
    ? `📊 **সংক্ষিপ্ত বিবরণ:**\n- মোট বন্ধু: ${summary.total}\n- ${summary.radius} কিমির মধ্যে কাছাকাছি: ${summary.nearby}\n- অবস্থান শেয়ার করেছেন: ${summary.withLocation}`
    : `📊 **Summary:**\n- Total Friends: ${summary.total}\n- Nearby (within ${summary.radius} km): ${summary.nearby}\n- Shared Location: ${summary.withLocation}`;
}

/**
 * Generate detailed friend information
 */
function getFriendsDetails(friends, lang = "eng") {
  let details =
    lang === "bn"
      ? "👥 **কাছাকাছি বন্ধুদের বিস্তারিত:**\n\n"
      : "👥 **Nearby Friends Details:**\n\n";

  friends.forEach((friend, index) => {
    const emoji =
      index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "📍";

    details += `${emoji} **${friend.name}**\n`;

    if (friend.distance !== null) {
      details +=
        lang === "bn"
          ? `   📏 দূরত্ব: ${friend.distance.toFixed(2)} কিমি\n`
          : `   📏 Distance: ${friend.distance.toFixed(2)} km\n`;

      details +=
        lang === "bn"
          ? `   🧭 দিক: ${friend.direction}\n`
          : `   🧭 Direction: ${friend.direction}\n`;

      if (friend.address) {
        details +=
          lang === "bn"
            ? `   📍 ঠিকানা: ${friend.address}\n`
            : `   📍 Address: ${friend.address}\n`;
      }

      details +=
        lang === "bn"
          ? `   ℹ️ বর্ণনা: ${friend.message}\n`
          : `   ℹ️ Info: ${friend.message}\n`;
    }

    details += "\n";
  });

  return details;
}

/**
 * Generate message when no friends are nearby
 */
function getNoFriendsMessage(totalFriends, lang = "eng") {
  if (totalFriends === 0) {
    return lang === "bn"
      ? "❌ কোনো বন্ধু এখনও তাদের অবস্থান শেয়ার করেননি। তাদের অবস্থান শেয়ার করতে বলুন!"
      : "❌ None of your friends have shared their location yet. Ask them to share their location!";
  }

  return lang === "bn"
    ? `⚠️ আপনার ${totalFriends} জন বন্ধু দূরে রয়েছেন।`
    : `⚠️ Your ${totalFriends} friends are too far away.`;
}

/**
 * Generate helpful suggestions
 */
function getSuggestions(friends, lang = "eng") {
  let suggestions =
    lang === "bn"
      ? "💡 **সহায়ক পরামর্শ:**\n"
      : "💡 **Helpful Suggestions:**\n";

  const closest = friends[0];
  suggestions +=
    lang === "bn"
      ? `✓ আপনার সবচেয়ে কাছের বন্ধু হল ${closest.name} (${closest.distance.toFixed(2)} কিমি দূরে)\n`
      : `✓ Your closest friend is ${closest.name} (${closest.distance.toFixed(2)} km away)\n`;

  if (friends.length > 1) {
    const average = (
      friends.reduce((sum, f) => sum + f.distance, 0) / friends.length
    ).toFixed(2);
    suggestions +=
      lang === "bn"
        ? `✓ গড় দূরত্ব: ${average} কিমি\n`
        : `✓ Average distance: ${average} km\n`;
  }

  suggestions +=
    lang === "bn"
      ? `✓ আপনি বন্ধুদের সাথে দেখা করতে পারেন!\n`
      : `✓ You can meet up with your friends!\n`;

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
    const locationData = await getFriendsLocations(
      userProfile,
      latitude,
      longitude,
      {
        lang,
        radiusKm,
      },
    );

    // If query is about specific friend, handle differently
    if (parsedQuery.isSingleFriend && query.includes("where")) {
      return buildSingleFriendResponse(locationData, query, lang);
    }

    // Build detailed chat response
    const detailedResponse = buildDetailedResponse(locationData, lang);

    // Add timestamp and metadata
    return {
      success: true,
      message: detailedResponse,
      queryType: parsedQuery.type,
      friendsFound: locationData.friends.filter((f) => f.distance !== null)
        .length,
      totalFriends: locationData.summary.total,
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
 * Build response for single friend query
 */
function buildSingleFriendResponse(locationData, query, lang = "eng") {
  // Extract friend name from query
  const friends = locationData.friends.filter((f) => f.distance !== null);

  if (friends.length === 0) {
    return {
      success: true,
      message:
        lang === "bn"
          ? "কোনো বন্ধু আপনার কাছাকাছি নেই বা তাদের অবস্থান শেয়ার করেননি।"
          : "No friends are near you or have shared their location.",
      friendsFound: 0,
    };
  }

  let response =
    lang === "bn"
      ? "🔍 **আপনার বন্ধুদের অবস্থান তথ্য:**\n\n"
      : "🔍 **Your Friends' Location Information:**\n\n";

  friends.forEach((friend) => {
    response += `📍 **${friend.name}**\n`;
    response +=
      lang === "bn"
        ? `   • দূরত্ব: ${friend.distance.toFixed(2)} কিমি\n`
        : `   • Distance: ${friend.distance.toFixed(2)} km\n`;
    response +=
      lang === "bn"
        ? `   • দিক: ${friend.direction}\n`
        : `   • Direction: ${friend.direction}\n`;
    if (friend.address) {
      response +=
        lang === "bn"
          ? `   • ঠিকানা: ${friend.address}\n`
          : `   • Address: ${friend.address}\n`;
    }
    response += "\n";
  });

  return {
    success: true,
    message: response,
    friendsFound: friends.length,
  };
}

/**
 * Get full friend details for chat display
 */
async function getFullFriendDetails(friendId, userProfileId, lang = "eng") {
  try {
    const userProfile = await Profile.findById(userProfileId);

    if (!userProfile || !userProfile.friends.includes(friendId)) {
      return {
        success: false,
        message:
          lang === "bn"
            ? "এই বন্ধু আপনার বন্ধু তালিকায় নেই।"
            : "This friend is not in your friends list.",
      };
    }

    const friend = await Profile.findById(friendId)
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

    if (!friend) {
      return {
        success: false,
        message:
          lang === "bn"
            ? "বন্ধু প্রোফাইল খুঁজে পাওয়া যায়নি।"
            : "Friend profile not found.",
      };
    }

    // Format detailed response
    let details =
      lang === "bn"
        ? `👤 **${friend.fullName} এর সম্পূর্ণ তথ্য:**\n\n`
        : `👤 **Complete Information about ${friend.fullName}:**\n\n`;

    details += lang === "bn" ? `**ব্যক্তিগত তথ্য:**\n` : `**Personal Info:**\n`;
    details +=
      lang === "bn"
        ? `   • ডিসপ্লে নাম: ${friend.displayName || "-"}\n`
        : `   • Display Name: ${friend.displayName || "-"}\n`;
    details +=
      lang === "bn"
        ? `   • ইউজারনেম: ${friend.username || "-"}\n`
        : `   • Username: ${friend.username || "-"}\n`;
    details +=
      lang === "bn"
        ? `   • ইমেইল: ${friend.user?.email || "-"}\n`
        : `   • Email: ${friend.user?.email || "-"}\n`;
    details +=
      lang === "bn"
        ? `   • বায়ো: ${friend.bio || "-"}\n`
        : `   • Bio: ${friend.bio || "-"}\n`;

    if (friend.lastLocation) {
      details += lang === "bn" ? `\n**অবস্থান:**\n` : `\n**Location:**\n`;
      details +=
        lang === "bn"
          ? `   • অক্ষাংশ: ${friend.lastLocation.latitude}\n`
          : `   • Latitude: ${friend.lastLocation.latitude}\n`;
      details +=
        lang === "bn"
          ? `   • দ্রাঘিমাংশ: ${friend.lastLocation.longitude}\n`
          : `   • Longitude: ${friend.lastLocation.longitude}\n`;
    }

    if (friend.presentAddress || friend.permanentAddress) {
      details += lang === "bn" ? `\n**ঠিকানা:**\n` : `\n**Addresses:**\n`;
      if (friend.presentAddress) {
        details +=
          lang === "bn"
            ? `   • বর্তমান: ${friend.presentAddress}\n`
            : `   • Present: ${friend.presentAddress}\n`;
      }
      if (friend.permanentAddress) {
        details +=
          lang === "bn"
            ? `   • স্থায়ী: ${friend.permanentAddress}\n`
            : `   • Permanent: ${friend.permanentAddress}\n`;
      }
    }

    if (friend.workPlaces && friend.workPlaces.length > 0) {
      details += lang === "bn" ? `\n**কর্মক্ষেত্র:**\n` : `\n**Workplaces:**\n`;
      friend.workPlaces.forEach((work) => {
        details +=
          lang === "bn"
            ? `   • ${work.company || "-"} (${work.position || "-"})\n`
            : `   • ${work.company || "-"} (${work.position || "-"})\n`;
      });
    }

    if (friend.schools && friend.schools.length > 0) {
      details +=
        lang === "bn" ? `\n**শিক্ষা প্রতিষ্ঠান:**\n` : `\n**Schools:**\n`;
      friend.schools.forEach((school) => {
        details +=
          lang === "bn"
            ? `   • ${school.name || "-"} (${school.degree || "-"})\n`
            : `   • ${school.name || "-"} (${school.degree || "-"})\n`;
      });
    }

    details += lang === "bn" ? `\n**স্থিতি:**\n` : `\n**Status:**\n`;
    details +=
      lang === "bn"
        ? `   • সক্রিয়: ${friend.isActive ? "হ্যাঁ ✓" : "না"}\n`
        : `   • Active: ${friend.isActive ? "Yes ✓" : "No"}\n`;

    if (friend.lastEmotion) {
      details +=
        lang === "bn"
          ? `   • মেজাজ: ${friend.lastEmotionText || friend.lastEmotion}\n`
          : `   • Mood: ${friend.lastEmotionText || friend.lastEmotion}\n`;
    }

    return {
      success: true,
      message: details,
      friend: {
        id: friend._id,
        name: friend.fullName,
        profilePic: friend.profilePic,
        isActive: friend.isActive,
      },
    };
  } catch (error) {
    console.error("Error in getFullFriendDetails:", error);
    return {
      success: false,
      message:
        lang === "bn"
          ? "বন্ধুর তথ্য সংগ্রহে ত্রুটি ঘটেছে।"
          : "Error retrieving friend details.",
      error: error.message,
    };
  }
}

module.exports = {
  parseLocationQuery,
  processLocationChatQuery,
  buildDetailedResponse,
  getFullFriendDetails,
};
