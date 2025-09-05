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



