const admin = require('firebase-admin');
const Profile = require('../models/Profile');

/**
 * Send a push notification to a list of device tokens using Firebase Admin SDK
 * @param {string[]} tokens
 * @param {{ title?: string, body?: string, data?: Record<string,string>, channelId?: string }} notification
 * @returns {Promise<{ successCount: number, failureCount: number }>} 
 */
async function sendPushToTokens(tokens = [], notification = {}) {

  console.log('tokens', tokens, 'notification', notification);
  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.warn('FCM send skipped: no device tokens');
    return { successCount: 0, failureCount: 0 };
  }

  // FCM tokens must be non-empty strings. Some clients/previous runs can leave '' in DB.
  const sanitizedTokens = tokens
    .map((t) => (t == null ? '' : String(t)))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
    console.log('sanitizedTokens', sanitizedTokens,tokens);

  if (sanitizedTokens.length === 0) {
    console.warn('FCM send skipped: no valid (non-empty) device tokens');
    return { successCount: 0, failureCount: 0 };
  }

  const redactToken = (t) => {
    if (!t) return '';
    const s = String(t);
    // Keep logging safe: show only first/last chars.
    return s.length <= 12 ? `${s}***` : `${s.slice(0, 6)}...${s.slice(-4)}`;
  };

  // Ensure body is never empty - fallback to data.message or a default message
  const notificationBody = notification.body || notification.data?.message || 'You have a new message';
  
  const payload = {
    notification: {
      title: notification.title || 'Notification',
      body: notificationBody,
    },
    data: Object.entries(notification.data || {}).reduce((acc, [k, v]) => {
      acc[k] = typeof v === 'string' ? v : String(v);
      return acc;
    }, {}),
    tokens: sanitizedTokens,
    android: {
      priority: 'high',
      directBootOk: true,
      notification: {
        channelId: String(notification.channelId || 'default'),
        sound: 'default',
      },
    },
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(payload);

    // sendEachForMulticast returns per-token results even when delivery fails.
    // Log response errors so we can pinpoint: "invalid token", "unregistered", etc.
    const previewTokens = sanitizedTokens.slice(0, 3).map(redactToken);
    console.log('FCM sendEachForMulticast result', {
      tokensCount: sanitizedTokens.length,
      previewTokens,
      successCount: res.successCount,
      failureCount: res.failureCount,
      payloadType: notification?.data?.type,
      // messageId is useful for correlating server-side events
      messageId: notification?.data?.messageId || notification?.data?.data?.messageId || undefined,
    });

    if (res.failureCount > 0 && Array.isArray(res.responses)) {
      const failed = res.responses
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => !r.success)
        .slice(0, 5);

      for (const { r, idx } of failed) {
        const err = r.error;
        console.warn('FCM failed token response', {
          tokenIndex: idx,
          token: redactToken(sanitizedTokens[idx]),
          errorCode: err?.code,
          errorMessage: err?.message,
        });
      }
    }

    return { successCount: res.successCount, failureCount: res.failureCount };
  } catch (err) {
    console.error('FCM send error:', err && err.message ? err.message : err);
    return { successCount: 0, failureCount: sanitizedTokens.length };
  }
}

/**
 * Send a push notification to a profile's registered device tokens
 * @param {string} profileId
 * @param {{ title?: string, body?: string, data?: Record<string,string>, channelId?: string }} notification
 */
async function sendPushToProfile(profileId, notification = {}) {

  console.log('sendPushToProfile', profileId, notification);
  if (!profileId) return { successCount: 0, failureCount: 0 };
  const profile = await Profile.findById(profileId).select('deviceTokens');
  const tokens = profile?.deviceTokens || [];
  console.log('FCM tokens for profile', {
    profileId,
    tokensCount: tokens.length,
    tokensPreview: tokens.slice(0, 3).map((t) => String(t).slice(0, 6) + '...' + String(t).slice(-4)),
  });
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

  const sanitizedTokens = tokens
    .map((t) => (t == null ? '' : String(t)))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (sanitizedTokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }

  const stringData = Object.entries(data || {}).reduce((acc, [k, v]) => {
    acc[k] = typeof v === 'string' ? v : String(v);
    return acc;
  }, {});
  try {
    const res = await admin.messaging().sendEachForMulticast({
      data: stringData,
      tokens: sanitizedTokens,
      android: {
        priority: 'high',
        ttl: 60 * 60 * 1000, // 1 hour (milliseconds per firebase-admin AndroidConfig)
        directBootOk: true,
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'background',
        },
        payload: {
          aps: {
            'content-available': 1,
          },
        },
      },
    });
    return { successCount: res.successCount, failureCount: res.failureCount };
  } catch (err) {
    console.error('FCM data send error:', err && err.message ? err.message : err);
    return { successCount: 0, failureCount: sanitizedTokens.length };
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

/**
 * Data-only FCM for new chat messages (receiver app killed / no socket).
 * @param {string} receiverId - profile id of message recipient
 * @param {{ senderId: any, updatedMessage: any, senderName: string, senderPP: string, friendProfile: any, room: string }} payload
 */
async function sendChatMessageDataPush(receiverId, payload) {
  const { senderId, updatedMessage, senderName, senderPP, friendProfile, room } = payload || {};
  if (!receiverId || !senderId || String(receiverId) === String(senderId)) {
    return { successCount: 0, failureCount: 0 };
  }
  if (!updatedMessage || !friendProfile) {
    return { successCount: 0, failureCount: 0 };
  }
  const messageBody =
    updatedMessage.messageType === 'audio' && updatedMessage.attachment
      ? 'Voice message'
      : updatedMessage.message;
  const friendForPush = {
    _id: String(friendProfile._id),
    profilePic: String(friendProfile.profilePic || senderPP || ''),
    fullName: String(
      friendProfile.fullName != null ? friendProfile.fullName : senderName || ''
    ),
  };
  if (friendProfile.user) {
    friendForPush.user = {
      _id: String(friendProfile.user._id || ''),
      firstName: String(friendProfile.user.firstName || ''),
      surname: String(friendProfile.user.surname || ''),
    };
  }
  return sendDataPushToProfile(receiverId, {
    type: 'chat',
    title: String(senderName || 'New Message'),
    body: String(messageBody || ''),
    senderId: String(senderId),
    receiverId: String(receiverId),
    room: String(room),
    messageId: String(updatedMessage._id),
    message: String(messageBody || ''),
    senderName: String(senderName || ''),
    friendJson: JSON.stringify(friendForPush),
  });
}

module.exports.sendDataPushToTokens = sendDataPushToTokens;
module.exports.sendDataPushToProfile = sendDataPushToProfile;
module.exports.sendChatMessageDataPush = sendChatMessageDataPush;



