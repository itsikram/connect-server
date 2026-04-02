/**
 * Push delivery:
 * - `ExponentPushToken[...]` / Expo tokens → Expo Push API (expo-notifications / iOS & Android Expo builds).
 * - Any other token → Firebase Cloud Messaging (native FCM registration tokens).
 * Optional: set EXPO_ACCESS_TOKEN for higher Expo push rate limits.
 */
const admin = require('firebase-admin');
const axios = require('axios');
const Profile = require('../models/Profile');

/** Expo / React Native apps using expo-notifications register these — not FCM registration tokens. */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Must match bundled `default_ringtone` in the mobile app (expo-notifications plugin + Android res/raw). */
const INCOMING_CALL_NOTIFICATION_SOUND = 'default_ringtone';

/**
 * Android notification channel id registered in expo-connect-app `configureNotificationsChannel`
 * (MAX importance, lock-screen visibility, sound). Use this for Expo + FCM `android.notification.channelId`.
 */
const EXPO_DEFAULT_ANDROID_CHANNEL_ID = 'messages_high';

function isExpoPushToken(token) {
  const s = String(token || '').trim();
  return s.startsWith('ExponentPushToken[') || s.startsWith('ExpoPushToken');
}

const redactToken = (t) => {
  if (!t) return '';
  const s = String(t);
  return s.length <= 12 ? `${s}***` : `${s.slice(0, 6)}...${s.slice(-4)}`;
};

/**
 * FCM `data` map rejects reserved keys (e.g. `from` → messaging/invalid-argument).
 * Strip those and any `google.*` / `gcm.*` keys before sendEachForMulticast.
 * @param {Record<string, string>} data
 * @returns {Record<string, string>}
 */
function sanitizeFcmDataKeys(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k === 'from' || k === 'message_type' || k === 'gcm') continue;
    if (k.startsWith('google.') || k.startsWith('gcm.')) continue;
    out[k] = v;
  }
  return out;
}

/** Expo accepts up to 100 messages per request. */
const EXPO_PUSH_MAX_BATCH = 100;

/**
 * @param {Array<{ to: string, title?: string, body?: string, data?: Record<string,string>, channelId?: string, sound?: string, priority?: string }>} messages
 */
async function sendExpoPushBatch(messages) {
  if (!messages || messages.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }
  let successCount = 0;
  let failureCount = 0;
  try {
    for (let offset = 0; offset < messages.length; offset += EXPO_PUSH_MAX_BATCH) {
      const chunk = messages.slice(offset, offset + EXPO_PUSH_MAX_BATCH);
      const { data: responseBody } = await axios.post(EXPO_PUSH_URL, chunk, {
        headers,
        timeout: 30000,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      const raw = responseBody?.data;
      const rows = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
      for (const row of rows) {
        if (row && row.status === 'ok') successCount += 1;
        else failureCount += 1;
      }
      if (rows.some((r) => r && r.status !== 'ok')) {
        const errs = rows.filter((r) => r && r.status !== 'ok').slice(0, 5);
        console.warn('Expo push partial failure', { chunkSize: chunk.length, sampleErrors: errs });
      }
    }
    console.log('Expo push result', { messagesCount: messages.length, successCount, failureCount });
    return { successCount, failureCount };
  } catch (err) {
    console.error('Expo push HTTP error:', err?.response?.data || err?.message || err);
    return { successCount: 0, failureCount: messages.length };
  }
}

/**
 * Send a push notification to a list of device tokens.
 * - Tokens starting with ExponentPushToken[...] are sent via Expo Push API (iOS/Android Expo apps).
 * - All other tokens are sent as FCM registration tokens via Firebase Admin.
 * @param {string[]} tokens
 * @param {{ title?: string, body?: string, data?: Record<string,string>, channelId?: string }} notification
 * @returns {Promise<{ successCount: number, failureCount: number }>}
 */
async function sendPushToTokens(tokens = [], notification = {}) {
  console.log('tokens', tokens, 'notification', notification);
  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.warn('Push send skipped: no device tokens');
    return { successCount: 0, failureCount: 0 };
  }

  const sanitizedTokens = tokens
    .map((t) => (t == null ? '' : String(t)))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  console.log('sanitizedTokens', tokens, tokens.length, sanitizedTokens);

  if (sanitizedTokens.length === 0) {
    console.warn('Push send skipped: no valid (non-empty) device tokens');
    return { successCount: 0, failureCount: 0 };
  }

  const expoTokens = sanitizedTokens.filter(isExpoPushToken);
  const fcmTokens = sanitizedTokens.filter((t) => !isExpoPushToken(t));

  const notificationBody = notification.body || notification.data?.message || 'You have a new message';
  const stringData = sanitizeFcmDataKeys(
    Object.entries(notification.data || {}).reduce((acc, [k, v]) => {
      acc[k] = typeof v === 'string' ? v : String(v);
      return acc;
    }, {}),
  );

  const isIncomingCall = stringData.type === 'incoming_call';
  const pushSound = isIncomingCall ? INCOMING_CALL_NOTIFICATION_SOUND : 'default';

  let successCount = 0;
  let failureCount = 0;

  if (expoTokens.length > 0) {
    const channelId = String(notification.channelId || EXPO_DEFAULT_ANDROID_CHANNEL_ID);
    const messages = expoTokens.map((to) => ({
      to,
      title: notification.title || 'Notification',
      body: notificationBody,
      data: stringData,
      sound: pushSound,
      priority: 'high',
      channelId,
    }));
    const expoResult = await sendExpoPushBatch(messages);
    successCount += expoResult.successCount;
    failureCount += expoResult.failureCount;
  }

  if (fcmTokens.length === 0) {
    return { successCount, failureCount };
  }

  const titleStr = String(notification.title || 'Notification');
  const bodyStr = String(notificationBody);

  const payload = {
    notification: {
      title: notification.title || 'Notification',
      body: notificationBody,
    },
    data: stringData,
    tokens: fcmTokens,
    android: {
      priority: 'high',
      directBootOk: true,
      notification: {
        channelId: String(notification.channelId || EXPO_DEFAULT_ANDROID_CHANNEL_ID),
        sound: pushSound,
      },
    },
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(payload);

    const previewTokens = fcmTokens.slice(0, 3).map(redactToken);
    console.log('FCM sendEachForMulticast result', {
      tokensCount: fcmTokens.length,
      previewTokens,
      successCount: res.successCount,
      failureCount: res.failureCount,
      payloadType: notification?.data?.type,
      messageId: notification?.data?.messageId || notification?.data?.data?.messageId || undefined,
    });

    successCount += res.successCount;
    failureCount += res.failureCount;

    if (res.failureCount > 0 && Array.isArray(res.responses)) {
      const failed = res.responses
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => !r.success)
        .slice(0, 5);

      for (const { r, idx } of failed) {
        const err = r.error;
        console.warn('FCM failed token response', {
          tokenIndex: idx,
          token: redactToken(fcmTokens[idx]),
          errorCode: err?.code,
          errorMessage: err?.message,
        });
      }
    }

    return { successCount, failureCount };
  } catch (err) {
    console.error('FCM send error:', err && err.message ? err.message : err);
    return {
      successCount,
      failureCount: failureCount + fcmTokens.length,
    };
  }
}

/**
 * Send a push notification to a profile's registered device tokens
 * @param {string} profileId - Profile _id, or User _id (Profile.user ref)
 * @param {{ title?: string, body?: string, data?: Record<string,string>, channelId?: string }} notification
 */
async function sendPushToProfile(profileId, notification = {}) {

  if (!profileId) return { successCount: 0, failureCount: 0 };
  const profile = await Profile.findOne({
    $or: [{ _id: profileId }, { user: profileId }],
  }).select('deviceTokens');
  const tokens = profile?.deviceTokens || [];
  console.log('Push tokens for profile', {
    profileId,
    tokensCount: tokens.length,
    tokensPreview: tokens.slice(0, 3).map((t) => String(t).slice(0, 6) + '...' + String(t).slice(-4)),
    profile
  });
  console.log('sendPushToProfile working', profileId, tokens, notification);

  return sendPushToTokens(tokens, notification);
}

module.exports = {
  sendPushToTokens,
  sendPushToProfile,
};

/**
 * Chat → native FCM: **data-only** on Android so RN `setBackgroundMessageHandler` runs and Notifee
 * can post on `messages_chat_peek_v1` (HIGH / heads-up). Do not set `android.notification` here:
 * it sets `remoteMessage.notification`, which makes the client skip Notifee and shows a low-importance
 * system notification on `messages_high` (peek=F on some OEMs).
 * iOS: `apns.payload.aps.alert` for banners when terminated.
 * @param {string[]} fcmTokens
 * @param {{ title: string, body: string, data: Record<string, string> }} opts
 */
async function sendFcmChatMulticast(fcmTokens, { title, body, data }) {
  if (!fcmTokens || fcmTokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }
  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens: fcmTokens,
      data,
      android: {
        priority: 'high',
        ttl: 60 * 60 * 1000,
        directBootOk: true,
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            alert: {
              title: title || 'Message',
              body: body || ' ',
            },
            sound: 'default',
          },
        },
      },
    });
    console.log('[FCM chat] data-only-android + apns multicast', {
      tokens: fcmTokens.length,
      successCount: res.successCount,
      failureCount: res.failureCount,
      messageId: data.messageId,
    });
    return { successCount: res.successCount, failureCount: res.failureCount };
  } catch (err) {
    console.error('[FCM chat] multicast error:', err && err.message ? err.message : err);
    return { successCount: 0, failureCount: fcmTokens.length };
  }
}

/**
 * New chat message push: Expo tokens get title/body via Expo API; FCM tokens get Android data-only + iOS alert.
 * @param {string[]} tokens
 * @param {{ title: string, body: string, data: Record<string, string> }} opts
 */
async function sendChatMessagePushToTokens(tokens = [], { title, body, data }) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.warn('[FCM chat] no tokens');
    return { successCount: 0, failureCount: 0 };
  }
  const sanitizedTokens = tokens
    .map((t) => (t == null ? '' : String(t)))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (sanitizedTokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }

  const expoTokens = sanitizedTokens.filter(isExpoPushToken);
  const fcmTokens = sanitizedTokens.filter((t) => !isExpoPushToken(t));

  let successCount = 0;
  let failureCount = 0;

  if (expoTokens.length > 0) {
    const channelId = EXPO_DEFAULT_ANDROID_CHANNEL_ID;
    const messages = expoTokens.map((to) => ({
      to,
      title: title || 'Message',
      body: body || ' ',
      data,
      sound: 'default',
      priority: 'high',
      channelId,
    }));
    const expoResult = await sendExpoPushBatch(messages);
    successCount += expoResult.successCount;
    failureCount += expoResult.failureCount;
  }

  if (fcmTokens.length > 0) {
    const fcmResult = await sendFcmChatMulticast(fcmTokens, { title, body, data });
    successCount += fcmResult.successCount;
    failureCount += fcmResult.failureCount;
  }

  return { successCount, failureCount };
}

/**
 * Send a data-only push notification to a list of device tokens
 * Note: All values in the data payload must be strings.
 * Expo tokens use Expo Push API; FCM tokens use Firebase Admin.
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

  const stringData = sanitizeFcmDataKeys(
    Object.entries(data || {}).reduce((acc, [k, v]) => {
      acc[k] = typeof v === 'string' ? v : String(v);
      return acc;
    }, {}),
  );

  const expoTokens = sanitizedTokens.filter(isExpoPushToken);
  const fcmTokens = sanitizedTokens.filter((t) => !isExpoPushToken(t));

  let successCount = 0;
  let failureCount = 0;

  if (expoTokens.length > 0) {
    const messages = expoTokens.map((to) => ({
      to,
      data: stringData,
      priority: 'high',
      channelId: EXPO_DEFAULT_ANDROID_CHANNEL_ID,
    }));
    const expoResult = await sendExpoPushBatch(messages);
    successCount += expoResult.successCount;
    failureCount += expoResult.failureCount;
  }

  if (fcmTokens.length === 0) {
    return { successCount, failureCount };
  }

  try {
    const res = await admin.messaging().sendEachForMulticast({
      data: stringData,
      tokens: fcmTokens,
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
    successCount += res.successCount;
    failureCount += res.failureCount;
    return { successCount, failureCount };
  } catch (err) {
    console.error('FCM data send error:', err && err.message ? err.message : err);
    return { successCount, failureCount: failureCount + fcmTokens.length };
  }
}

/**
 * Send a data-only push to a profile's registered device tokens
 * @param {string} profileId - Profile _id, or User _id (Profile.user ref)
 * @param {Record<string,string>} data
 */
async function sendDataPushToProfile(profileId, data = {}) {
  if (!profileId) return { successCount: 0, failureCount: 0 };
  const profile = await Profile.findOne({
    $or: [{ _id: profileId }, { user: profileId }],
  })
  const tokens = profile?.deviceTokens || [];
  return sendDataPushToTokens(tokens, data);
}

/**
 * FCM for new chat messages (receiver app killed / no socket).
 * Native FCM: data-only on Android so JS background handler + Notifee display; iOS gets APNS alert in same send.
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
  const title = String(senderName || 'New Message');
  const body = String(messageBody || '');
  const data = sanitizeFcmDataKeys({
    type: 'chat',
    title,
    body,
    senderId: String(senderId),
    receiverId: String(receiverId),
    room: String(room),
    messageId: String(updatedMessage._id),
    message: String(messageBody || ''),
    senderName: String(senderName || ''),
    senderPic: String(friendProfile.profilePic || senderPP || ''),
  });

  const profile = await Profile.findOne({
    $or: [{ _id: receiverId }, { user: receiverId }],
  }).select('deviceTokens');
  const tokens = profile?.deviceTokens || [];

  if (!tokens.length) {
    console.warn('[FCM chat] no deviceTokens on profile; client must POST /api/notification/token/register', {
      receiverId: String(receiverId),
    });
  }

  return sendChatMessagePushToTokens(tokens, { title, body, data });
}

module.exports.sendDataPushToTokens = sendDataPushToTokens;
module.exports.sendDataPushToProfile = sendDataPushToProfile;
module.exports.sendChatMessageDataPush = sendChatMessageDataPush;



