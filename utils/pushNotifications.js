/**
 * Push delivery:
 * - `ExponentPushToken[...]` / Expo tokens → Expo Push API (expo-notifications / iOS & Android Expo builds).
 * - Any other token → Firebase Cloud Messaging (native FCM registration tokens).
 * Optional: set EXPO_ACCESS_TOKEN for higher Expo push rate limits.
 */
const admin = require('firebase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Profile = require('../models/Profile');
const { getIncomingCallAlertForProfile } = require('./ringtone');

function ensureFirebaseAdminInitialized() {
  if (admin.apps && admin.apps.length > 0) return;

  // Do not create a second Firebase app here. The main server bootstrap in index.js is the
  // single source of truth for Firebase Admin initialization. This module should only guard and
  // fail fast if no app is available yet.
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const envB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (envJson && envJson.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(envJson);
      if (parsed && parsed.type === 'service_account') {
        admin.initializeApp({
          credential: admin.credential.cert(parsed),
          projectId: projectId || parsed.project_id,
        });
        return;
      }
    } catch (err) {
      console.warn('[firebase] FIREBASE_SERVICE_ACCOUNT exists but is not valid JSON; skipping fallback init in pushNotifications.js.', err?.message || err);
    }
  }

  if (envB64 && envB64.trim()) {
    try {
      const decoded = JSON.parse(Buffer.from(envB64, 'base64').toString('utf8'));
      if (decoded && decoded.type === 'service_account') {
        admin.initializeApp({
          credential: admin.credential.cert(decoded),
          projectId: projectId || decoded.project_id,
        });
        return;
      }
    } catch (err) {
      console.warn('[firebase] FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid; skipping fallback init in pushNotifications.js.', err?.message || err);
    }
  }

  const candidateNames = ['serviceAccountKey.json', 'serviceAccountKeys.json'];
  for (const fileName of candidateNames) {
    const filePath = path.join(__dirname, '..', fileName);
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && parsed.type === 'service_account') {
          admin.initializeApp({
            credential: admin.credential.cert(parsed),
            projectId: projectId || parsed.project_id,
          });
          return;
        }
      } catch (err) {
        console.warn('[firebase] Local service account file exists but is invalid:', err?.message || err);
      }
    }
  }

  console.warn('[firebase] Firebase Admin not initialized yet; push delivery will be skipped until index.js boots the app with valid credentials.');
}

/** Expo / React Native apps using expo-notifications register these — not FCM registration tokens. */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Bundled mobile sounds: ringtone_1.mp3 … ringtone_5.mp3 via expo-notifications plugin. */
const INCOMING_CALL_NOTIFICATION_SOUND = 'ringtone_1';

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

function isStaleFcmTokenError(error) {
  const code = error?.code || error?.error?.code || '';
  const message = String(error?.message || error?.error?.message || '');
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    message.includes('registration-token-not-registered') ||
    message.includes('not registered') ||
    message.includes('invalid-registration-token') ||
    message.includes('registration token') && message.toLowerCase().includes('invalid')
  );
}

async function removeStaleDeviceTokens(profileId, invalidTokens = []) {
  if (!profileId || !Array.isArray(invalidTokens) || invalidTokens.length === 0) {
    return 0;
  }

  const tokens = [...new Set(invalidTokens.map((t) => String(t || '').trim()).filter(Boolean))];
  if (tokens.length === 0) {
    return 0;
  }

  try {
    const result = await Profile.updateOne(
      { $or: [{ _id: profileId }, { user: profileId }] },
      { $pullAll: { deviceTokens: tokens } },
    );
    const removed = Number(result?.modifiedCount || 0);
    if (removed > 0) {
      console.warn('[push] removed stale FCM tokens from profile', {
        profileId,
        count: removed,
        preview: tokens.slice(0, 3).map((t) => redactToken(t)),
      });
    }
    return removed;
  } catch (err) {
    console.warn('[push] failed to remove stale FCM tokens', {
      profileId,
      error: err?.message || err,
    });
    return 0;
  }
}

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
    // Expo rejects a request containing tokens from different Expo projects
    // (PUSH_TOO_MANY_EXPERIENCE_IDS). Tokens are intentionally allowed to
    // coexist while users upgrade/reinstall, so send one token per request.
    for (let offset = 0; offset < messages.length; offset += EXPO_PUSH_MAX_BATCH) {
      const chunk = messages.slice(offset, offset + EXPO_PUSH_MAX_BATCH);
      for (const message of chunk) {
        try {
          const { data: responseBody } = await axios.post(EXPO_PUSH_URL, [message], {
            headers,
            timeout: 30000,
            validateStatus: (s) => s >= 200 && s < 300,
          });
          const row = Array.isArray(responseBody?.data)
            ? responseBody.data[0]
            : responseBody?.data;
          if (row && row.status === 'ok') {
            successCount += 1;
            continue;
          }
          failureCount += 1;
          console.warn('Expo push failure', {
            token: redactToken(message.to),
            error: row,
          });
        } catch (err) {
          failureCount += 1;
          console.warn('Expo push request failed', {
            token: redactToken(message.to),
            error: err?.response?.data || err?.message || err,
          });
        }
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
  const androidSoundName = isIncomingCall
    ? String(stringData.soundName || INCOMING_CALL_NOTIFICATION_SOUND)
    : 'default';
  const iosSoundName = isIncomingCall
    ? String(notification.sound || `${androidSoundName}.mp3`)
    : 'default';
  const incomingChannelId =
    notification.channelId ||
    stringData.channelId ||
    (isIncomingCall ? 'incoming_calls_r1_v6' : EXPO_DEFAULT_ANDROID_CHANNEL_ID);

  let successCount = 0;
  let failureCount = 0;
  let invalidTokens = [];

  if (expoTokens.length > 0) {
    const channelId = isIncomingCall
      ? incomingChannelId
      : String(notification.channelId || EXPO_DEFAULT_ANDROID_CHANNEL_ID);
    const messages = expoTokens.map((to) => {
      const message = {
        to,
        title: notification.title || 'Notification',
        body: notificationBody,
        data: stringData,
        sound: 'default',
        priority: 'high',
        channelId,
      };
      if (isIncomingCall) {
        // Expo Go iOS has no custom ringtone files; `default` is the sound that actually plays.
        message.sound = 'default';
        message.ttl = 60;
        message.expiration = Math.floor(Date.now() / 1000) + 60;
        message.interruptionLevel = 'time-sensitive';
        message.categoryId = 'incoming_call';
        message.mutableContent = false;
        message.badge = 1;
      }
      return message;
    });
    const expoResult = await sendExpoPushBatch(messages);
    successCount += expoResult.successCount;
    failureCount += expoResult.failureCount;
  }

  if (fcmTokens.length === 0) {
   return { successCount, failureCount, invalidTokens };
  }

  ensureFirebaseAdminInitialized();
  if (!admin.apps || admin.apps.length === 0) {
   console.warn('[firebase] Skipping FCM send because Firebase Admin is not initialized for this process.', {
     profileTokens: fcmTokens.length,
     reason: 'missing_default_app',
   });
   return { successCount, failureCount: failureCount + fcmTokens.length, invalidTokens: [...new Set(invalidTokens)] };
  }

  const titleStr = String(notification.title || 'Notification');
  const bodyStr = String(notificationBody);

  /** Data-only on Android so a killed app still receives FCM in our MessagingService,
   *  which posts Accept/Decline. A `notification` payload would be shown by the OS
   *  with no action buttons and would skip onMessageReceived. */
  if (isIncomingCall) {
    try {
      const res = await admin.messaging().sendEachForMulticast({
        tokens: fcmTokens,
        data: {
          ...stringData,
          title: titleStr,
          body: bodyStr,
        },
        android: {
          priority: 'high',
          ttl: 120 * 1000,
          directBootOk: true,
        },
        apns: {
          headers: {
            'apns-priority': '10',
            'apns-push-type': 'alert',
            'apns-expiration': String(Math.floor(Date.now() / 1000) + 60),
          },
          payload: {
            aps: {
              alert: { title: titleStr, body: bodyStr },
              sound: iosSoundName,
              'interruption-level': 'time-sensitive',
              category: 'incoming_call',
            },
          },
        },
      });
      successCount += res.successCount;
      failureCount += res.failureCount;
      if (res.failureCount > 0 && Array.isArray(res.responses)) {
        const failed = res.responses
          .map((r, idx) => ({ r, idx }))
          .filter(({ r }) => !r.success)
          .slice(0, 5);
        for (const { r, idx } of failed) {
         if (isStaleFcmTokenError(r.error)) {
           invalidTokens.push(fcmTokens[idx]);
         }
         console.warn('FCM incoming_call send failure', {
           idx,
           token: redactToken(fcmTokens[idx]),
           error: r.error && r.error.toJSON ? r.error.toJSON() : r.error,
         });
       }
     }
     return { successCount, failureCount, invalidTokens: [...new Set(invalidTokens)] };
   } catch (err) {
     console.error('FCM incoming_call multicast error:', err && err.message ? err.message : err);
     if (isStaleFcmTokenError(err)) {
       invalidTokens.push(...fcmTokens);
     }
     return {
       successCount,
       failureCount: failureCount + fcmTokens.length,
       invalidTokens: [...new Set(invalidTokens)],
     };
   }
  }

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
       sound: 'default',
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
       if (isStaleFcmTokenError(err)) {
         invalidTokens.push(fcmTokens[idx]);
       }
       console.warn('FCM failed token response', {
         tokenIndex: idx,
         token: redactToken(fcmTokens[idx]),
         errorCode: err?.code,
         errorMessage: err?.message,
       });
     }
   }

   return { successCount, failureCount, invalidTokens: [...new Set(invalidTokens)] };
  } catch (err) {
   console.error('FCM send error:', err && err.message ? err.message : err);
   if (isStaleFcmTokenError(err)) {
     invalidTokens.push(...fcmTokens);
   }
   return {
     successCount,
     failureCount: failureCount + fcmTokens.length,
     invalidTokens: [...new Set(invalidTokens)],
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

  let nextNotification = notification;
  if (notification?.data?.type === 'incoming_call') {
    const alert = await getIncomingCallAlertForProfile(profileId);
    nextNotification = {
      ...notification,
      channelId: alert.channelId,
      sound: alert.iosSound,
      data: {
        ...(notification.data || {}),
        ringtoneId: String(alert.id),
        channelId: alert.channelId,
        soundName: alert.soundName,
      },
    };
  }

  console.log('Push tokens for profile', {
    profileId,
    tokensCount: tokens.length,
    tokensPreview: tokens.slice(0, 3).map((t) => String(t).slice(0, 6) + '...' + String(t).slice(-4)),
    profile
  });
  console.log('sendPushToProfile working', profileId, tokens, nextNotification);

  const result = await sendPushToTokens(tokens, nextNotification);
  if (Array.isArray(result?.invalidTokens) && result.invalidTokens.length > 0) {
    await removeStaleDeviceTokens(profileId, result.invalidTokens);
  }
  return result;
}

ensureFirebaseAdminInitialized();

module.exports = {
  sendPushToTokens,
  sendPushToProfile,
};

/**
 * Chat → native FCM: include an Android notification payload so the OS can
 * display it when the app process has been terminated. The data remains
 * available for navigation when the user taps the notification.
 * iOS: `apns.payload.aps.alert` for banners when terminated.
 * @param {string[]} fcmTokens
 * @param {{ title: string, body: string, data: Record<string, string> }} opts
 */
async function sendFcmChatMulticast(fcmTokens, { title, body, data }) {
  if (!fcmTokens || fcmTokens.length === 0) {
    return { successCount: 0, failureCount: 0 };
  }
  ensureFirebaseAdminInitialized();
  if (!admin.apps || admin.apps.length === 0) {
    console.warn('[firebase] Skipping chat FCM send because Firebase Admin is not initialized for this process.');
    return { successCount: 0, failureCount: fcmTokens.length };
  }
  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens: fcmTokens,
      // Keep the notification at the top level as well as in the Android
      // config. This is the canonical FCM display payload and lets Android
      // render the notification when the app process was swiped away.
      notification: {
        title: title || 'Message',
        body: body || ' ',
      },
      data,
      android: {
        priority: 'high',
        ttl: 60 * 60 * 1000,
        directBootOk: true,
        notification: {
          title: title || 'Message',
          body: body || ' ',
          channelId: 'messages_chat_peek_v3',
        },
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
    console.log('[FCM chat] Android notification + data, APNs alert multicast', {
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
 * New chat message push: Expo tokens get title/body via Expo API; FCM tokens
 * get a visible Android notification plus data for tap navigation.
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

  ensureFirebaseAdminInitialized();
  if (!admin.apps || admin.apps.length === 0) {
    console.warn('[firebase] Skipping data FCM send because Firebase Admin is not initialized for this process.');
    return { successCount, failureCount: failureCount + fcmTokens.length };
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

  // Web Push is sent once from saveNotification — do not send here or iOS gets duplicates
  return sendChatMessagePushToTokens(tokens, { title, body, data });
}

module.exports.sendDataPushToTokens = sendDataPushToTokens;
module.exports.sendDataPushToProfile = sendDataPushToProfile;
module.exports.sendChatMessageDataPush = sendChatMessageDataPush;
