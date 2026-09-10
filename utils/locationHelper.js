/**
 * Location Helper Utilities
 * Provides utility functions for location-based features
 */

const { translate } = require('./localization/translations');

/**
 * Format location response based on context
 * @param {object} connects - Array of connects with location data
 * @param {string} lang - Language code
 * @returns {string} - Formatted response text
 */
function formatConnectsResponse(connects, lang = 'eng') {
  if (!connects || connects.length === 0) {
    return translate('noConnectsFound', lang);
  }

  let response = translate('detailedResponse', lang) + '\n\n';

  connects.forEach((connect, index) => {
    response += `${index + 1}. ${connect.name}\n`;
    response += `   Distance: ${connect.distance.toFixed(2)} km\n`;
    response += `   Direction: ${connect.direction}\n`;
    if (connect.address) {
      response += `   Address: ${connect.address}\n`;
    }
    response += '\n';
  });

  return response;
}

/**
 * Convert distance to human-readable format
 * @param {number} distance - Distance in kilometers
 * @param {string} lang - Language code
 * @returns {string} - Formatted distance string
 */
function formatDistance(distance, lang = 'eng') {
  if (distance < 1) {
    const meters = Math.round(distance * 1000);
    return lang === 'bn' ? `${meters} মিটার` : `${meters} meters`;
  }

  return lang === 'bn'
    ? `${distance.toFixed(2)} কিমি`
    : `${distance.toFixed(2)} km`;
}

/**
 * Get privacy-safe location data (rounded coordinates)
 * @param {number} latitude - Original latitude
 * @param {number} longitude - Original longitude
 * @param {number} precision - Decimal places (default: 3 = ~111m accuracy)
 * @returns {object} - Rounded location coordinates
 */
function getSafeLocationData(latitude, longitude, precision = 3) {
  const factor = Math.pow(10, precision);

  return {
    latitude: Math.round(latitude * factor) / factor,
    longitude: Math.round(longitude * factor) / factor,
    precision: `~${Math.round(111000 / factor)} meters`
  };
}

/**
 * Generate geohash for location clustering
 * (Simple implementation - not full geohashing)
 * @param {number} latitude - Latitude
 * @param {number} longitude - Longitude
 * @param {number} precision - Precision level (1-8)
 * @returns {string} - Geohash string
 */
function generateGeohash(latitude, longitude, precision = 5) {
  const lat = (latitude + 90) / 180;
  const lon = (longitude + 180) / 360;

  let hash = '';
  let bits = 0;
  let latMax = 1, latMin = 0;
  let lonMax = 1, lonMin = 0;
  let bit = 0;

  for (let i = 0; i < precision * 5; i++) {
    if (bit % 2 === 0) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        hash += '1';
        lonMin = mid;
      } else {
        hash += '0';
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        hash += '1';
        latMin = mid;
      } else {
        hash += '0';
        latMax = mid;
      }
    }

    if ((i + 1) % 5 === 0) {
      hash = baseEncode(parseInt(hash, 2)) + (i + 1 < precision * 5 ? '' : '');
      hash = hash.substring(0, precision);
      bits = 0;
      bit = 0;
    } else {
      bit++;
    }
  }

  return hash;
}

/**
 * Helper function for geohashing
 */
function baseEncode(num) {
  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  return base32[num % 32];
}

/**
 * Check if two locations are within a certain distance
 * @param {number} lat1 - First location latitude
 * @param {number} lon1 - First location longitude
 * @param {number} lat2 - Second location latitude
 * @param {number} lon2 - Second location longitude
 * @param {number} radiusKm - Radius in kilometers
 * @returns {boolean} - True if within radius
 */
function isWithinRadius(lat1, lon1, lat2, lon2, radiusKm) {
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

  return distance <= radiusKm;
}

/**
 * Get AI-connectly location description
 * @param {object} connect - Connect object with location data
 * @param {number} userLat - User's latitude
 * @param {number} userLon - User's longitude
 * @param {string} lang - Language code
 * @returns {string} - Connectly location description
 */
function getLocationDescription(connect, userLat, userLon, lang = 'eng') {
  if (!connect.distance) {
    return translate('noLocation', lang, connect.name);
  }

  let description = connect.name + ' is ';

  // Direction
  if (connect.direction) {
    description += `to the ${connect.direction}, `;
  }

  // Distance
  if (connect.distance < 0.1) {
    description += lang === 'bn' ? 'খুব কাছে' : 'very close';
  } else if (connect.distance < 1) {
    description += formatDistance(connect.distance, lang);
  } else if (connect.distance < 5) {
    description += lang === 'bn' ? 'কাছাকাছি' : 'nearby';
  } else if (connect.distance < 50) {
    description += lang === 'bn' ? 'মধ্যম দূরত্বে' : 'at a moderate distance';
  } else {
    description += lang === 'bn' ? 'অনেক দূরে' : 'quite far';
  }

  description += '.';

  return description;
}

/**
 * Batch update locations for multiple users
 * (Used for real-time location tracking)
 * @param {array} updates - Array of {profileId, latitude, longitude}
 * @returns {Promise} - Update result
 */
async function batchUpdateLocations(updates) {
  const Profile = require('../models/Profile');

  try {
    const bulkOps = updates.map(update => ({
      updateOne: {
        filter: { _id: update.profileId },
        update: {
          $set: {
            lastLocation: {
              latitude: update.latitude,
              longitude: update.longitude,
              timestamp: new Date()
            }
          }
        }
      }
    }));

    const result = await Profile.bulkWrite(bulkOps);
    return {
      success: true,
      modified: result.modifiedCount,
      errors: result.errors || []
    };
  } catch (error) {
    console.error('Error in batchUpdateLocations:', error);
    throw error;
  }
}

module.exports = {
  formatConnectsResponse,
  formatDistance,
  getSafeLocationData,
  generateGeohash,
  isWithinRadius,
  getLocationDescription,
  batchUpdateLocations
};
