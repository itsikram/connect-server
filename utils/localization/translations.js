/**
 * Localization and Translation Support
 * Supports Bengali (bn) and English (eng)
 */

const translations = {
  // Greeting messages
  greeting: {
    eng: "Hello! I'm your AI assistant. I can help you find your friends' locations.",
    bn: "নমস্কার! আমি আপনার এআই সহায়ক। আমি আপনার বন্ধুদের অবস্থান খুঁজে পেতে সাহায্য করতে পারি।"
  },

  // Friend location inquiry
  friendLocationInquiry: {
    eng: "I'll help you find your friends nearby based on your current location.",
    bn: "আমি আপনার বর্তমান অবস্থানের উপর ভিত্তি করে কাছাকাছি থাকা আপনার বন্ধুদের খুঁজে পেতে সাহায্য করব।"
  },

  // Distance-based messages
  veryClose: {
    eng: (name, distance) => `${name} is very close to you - only ${distance.toFixed(2)} km away`,
    bn: (name, distance) => `${name} আপনার খুব কাছে - মাত্র ${distance.toFixed(2)} কিমি দূরে`
  },

  nearby: {
    eng: (name, distance) => `${name} is nearby - approximately ${distance.toFixed(2)} km away`,
    bn: (name, distance) => `${name} কাছাকাছি - প্রায় ${distance.toFixed(2)} কিমি দূরে`
  },

  moderate: {
    eng: (name, distance) => `${name} is at a moderate distance of ${distance.toFixed(2)} km`,
    bn: (name, distance) => `${name} ${distance.toFixed(2)} কিমি দূরে বেশ পরিমাণে দূরত্বে রয়েছে`
  },

  far: {
    eng: (name, distance) => `${name} is quite far away - ${distance.toFixed(2)} km from you`,
    bn: (name, distance) => `${name} বেশ দূরে - আপনার থেকে ${distance.toFixed(2)} কিমি দূরে`
  },

  noLocation: {
    eng: (name) => `${name} has not shared their location yet`,
    bn: (name) => `${name} এখনও তাদের অবস্থান শেয়ার করেননি`
  },

  // Summary messages
  summaryHeading: {
    eng: "Friends Nearby - Summary",
    bn: "কাছাকাছি থাকা বন্ধুরা - সংক্ষিপ্ত বিবরণ"
  },

  noFriendsWithLocation: {
    eng: "None of your friends have shared their location.",
    bn: "আপনার কোনো বন্ধু তাদের অবস্থান শেয়ার করেননি।"
  },

  totalFriendsNearby: {
    eng: (count) => `You have ${count} friend(s) within 5 km of your location.`,
    bn: (count) => `আপনার অবস্থানের ৫ কিমির মধ্যে ${count} জন বন্ধু রয়েছেন।`
  },

  // Error messages
  invalidLocation: {
    eng: "Invalid location coordinates provided.",
    bn: "অবৈধ অবস্থান স্থানাঙ্ক প্রদান করা হয়েছে।"
  },

  noFriendsFound: {
    eng: "No friends found. Send friend requests to get started!",
    bn: "কোনো বন্ধু খুঁজে পাওয়া যায়নি। শুরু করতে বন্ধুর অনুরোধ পাঠান!"
  },

  profileNotFound: {
    eng: "Your profile was not found.",
    bn: "আপনার প্রোফাইল পাওয়া যায়নি।"
  },

  unauthorizedAccess: {
    eng: "You are not authorized to access this resource.",
    bn: "এই সম্পদ অ্যাক্সেস করার জন্য আপনি অনুমোদিত নন।"
  },

  // Privacy messages
  locationPrivacyEnabled: {
    eng: "Location sharing is currently disabled in your settings. Enable it to see friends' locations.",
    bn: "অবস্থান শেয়ারিং বর্তমানে আপনার সেটিংসে নিষ্ক্রিয়। বন্ধুদের অবস্থান দেখতে এটি সক্ষম করুন।"
  },

  // Request processing
  processingRequest: {
    eng: "Processing your location request...",
    bn: "আপনার অবস্থান অনুরোধ প্রক্রিয়া করছি..."
  },

  success: {
    eng: "Success! Here are your nearby friends:",
    bn: "সফল! এখানে আপনার কাছাকাছি থাকা বন্ধুরা রয়েছেন:"
  },

  // Direction messages
  north: { eng: "North", bn: "উত্তর" },
  south: { eng: "South", bn: "দক্ষিণ" },
  east: { eng: "East", bn: "পূর্ব" },
  west: { eng: "West", bn: "পশ্চিম" },
  northeast: { eng: "Northeast", bn: "উত্তর-পূর্ব" },
  northwest: { eng: "Northwest", bn: "উত্তর-পশ্চিম" },
  southeast: { eng: "Southeast", bn: "দক্ষিণ-পূর্ব" },
  southwest: { eng: "Southwest", bn: "দক্ষিণ-পশ্চিম" },

  // Direction helper message
  friendDirection: {
    eng: (name, direction, distance) => `${name} is to the ${direction}, ${distance.toFixed(2)} km away`,
    bn: (name, direction, distance) => `${name} ${direction}ে, ${distance.toFixed(2)} কিমি দূরে রয়েছেন`
  },

  // Summary list heading
  friendsList: {
    eng: "Nearby Friends List",
    bn: "কাছাকাছি বন্ধুদের তালিকা"
  },

  // Ranking
  closest: {
    eng: "Closest friend",
    bn: "নিকটতম বন্ধু"
  },

  // Response format
  detailedResponse: {
    eng: "Here's a detailed view of your nearby friends:",
    bn: "এখানে আপনার কাছাকাছি থাকা বন্ধুদের বিস্তারিত দৃশ্য রয়েছে:"
  }
};

/**
 * Get translation for a key in specified language
 * @param {string} key - Translation key
 * @param {string} lang - Language code ('eng' or 'bn')
 * @param {...any} args - Arguments for dynamic translations
 * @returns {string} - Translated text
 */
function translate(key, lang = 'eng', ...args) {
  if (!translations[key]) {
    console.warn(`Translation key not found: ${key}`);
    return key;
  }

  const translation = translations[key][lang] || translations[key]['eng'];

  if (typeof translation === 'function') {
    return translation(...args);
  }

  return translation;
}

/**
 * Get all translations for a key
 * @param {string} key - Translation key
 * @returns {object} - Object with eng and bn translations
 */
function getTranslations(key) {
  return translations[key] || { eng: key, bn: key };
}

module.exports = {
  translations,
  translate,
  getTranslations
};
