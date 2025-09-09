const admin = require('firebase-admin');
const Profile = require('../models/Profile');

/**
 * Send a push notification to a list of device tokens using Firebase Admin SDK
 * @param {string[]} tokens
 * @param {{ title?: string, body?: string, data?: Record<string,string> }} notification
 * @returns {Promise<{ successCount: number, failureCount: number }>} 
 */
async function sendPushToTokens(tokens = [], notification = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }

  const payload = {
    notification: {
      title: notification.title || 'Notification',
      body: notification.body || '',
    },
    data: Object.entries(notification.data || {}).reduce((acc, [k, v]) => {
      acc[k] = typeof v === 'string' ? v : String(v);
      return acc;
    }, {}),
    tokens,
    android: {
      priority: 'high',
    },
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(payload);
    return { successCount: res.successCount, failureCount: res.failureCount };
  } catch (err) {
    console.error('FCM send error:', err && err.message ? err.message : err);
    return { successCount: 0, failureCount: tokens.length };
  }
}

/**
 * Send a push notification to a profile's registered device tokens
 * @param {string} profileId
 * @param {{ title?: string, body?: string, data?: Record<string,string> }} notification
 */
async function sendPushToProfile(profileId, notification = {}) {
  if (!profileId) return { successCount: 0, failureCount: 0 };
  const profile = await Profile.findById(profileId).select('deviceTokens');
  const tokens = profile?.deviceTokens || [];
  return sendPushToTokens(tokens, notification);
}

module.exports = {
  sendPushToTokens,
  sendPushToProfile,
};

/**
 * Send a data-only push notification to a list of device tokens
 * Note: All values in the data payload must be strings.
 * @param {string[]} tokens
 * @param {Record<string,string>} data
 */
async function sendDataPushToTokens(tokens = [], data = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }
  const stringData = Object.entries(data || {}).reduce((acc, [k, v]) => {
    acc[k] = typeof v === 'string' ? v : String(v);
    return acc;
  }, {});
  try {
    const res = await admin.messaging().sendEachForMulticast({ data: stringData, tokens });
    return { successCount: res.successCount, failureCount: res.failureCount };
  } catch (err) {
    console.error('FCM data send error:', err && err.message ? err.message : err);
    return { successCount: 0, failureCount: tokens.length };
  }
}

/**
 * Send a data-only push to a profile's registered device tokens
 * @param {string} profileId
 * @param {Record<string,string>} data
 */
async function sendDataPushToProfile(profileId, data = {}) {
  if (!profileId) return { successCount: 0, failureCount: 0 };
  const profile = await Profile.findById(profileId).select('deviceTokens');
  const tokens = profile?.deviceTokens || [];
  return sendDataPushToTokens(tokens, data);
}

module.exports.sendDataPushToTokens = sendDataPushToTokens;
module.exports.sendDataPushToProfile = sendDataPushToProfile;



