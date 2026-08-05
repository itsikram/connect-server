/**
 * Web Push (VAPID) for iOS Home Screen / PWA background notifications.
 * Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT in server env.
 */
const webpush = require('web-push');
const Profile = require('../models/Profile');

const VAPID_PUBLIC = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT =
  (process.env.VAPID_SUBJECT || 'mailto:support@connect.app').trim();

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn(
      '[web-push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing — iOS background web notifications disabled'
    );
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
  return true;
}

function getVapidPublicKey() {
  return VAPID_PUBLIC || null;
}

function isWebPushReady() {
  return !!(VAPID_PUBLIC && VAPID_PRIVATE);
}

/**
 * Send a web push to all subscriptions on a profile. Removes expired (410/404) subs.
 * @param {string} profileId
 * @param {{ title?: string, body?: string, icon?: string, link?: string, tag?: string, data?: object }} payload
 */
async function sendWebPushToProfile(profileId, payload = {}) {
  if (!ensureConfigured() || !profileId) {
    return { successCount: 0, failureCount: 0, skipped: true };
  }

  const profile = await Profile.findById(profileId).select('webPushSubscriptions');
  const subs = profile?.webPushSubscriptions || [];
  if (!subs.length) {
    return { successCount: 0, failureCount: 0 };
  }

  const title = payload.title || 'Connect';
  const body = payload.body || payload.text || 'You have a new notification';
  const link = payload.link || '/';
  const icon = payload.icon || '/apple-touch-icon.png';
  const tag = payload.tag || payload.type || 'connect';

  const notificationPayload = JSON.stringify({
    title,
    body,
    icon,
    badge: '/apple-touch-icon.png',
    tag,
    requireInteraction: !!payload.requireInteraction,
    data: {
      ...(payload.data || {}),
      url: link,
      link,
      type: payload.type || 'general',
    },
  });

  let successCount = 0;
  let failureCount = 0;
  const staleEndpoints = [];

  await Promise.all(
    subs.map(async (sub) => {
      const subscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys?.p256dh,
          auth: sub.keys?.auth,
        },
      };
      if (!subscription.endpoint || !subscription.keys.p256dh || !subscription.keys.auth) {
        failureCount += 1;
        return;
      }
      try {
        await webpush.sendNotification(subscription, notificationPayload, {
          // Calls should expire quickly; default 24h for other alerts
          TTL: typeof payload.ttl === 'number' ? payload.ttl : 60 * 60 * 24,
          urgency: payload.urgency || 'high',
        });
        successCount += 1;
      } catch (err) {
        failureCount += 1;
        const status = err?.statusCode || err?.status;
        if (status === 404 || status === 410) {
          staleEndpoints.push(sub.endpoint);
        } else {
          console.warn('[web-push] send failed:', status || err?.message || err);
        }
      }
    })
  );

  if (staleEndpoints.length) {
    await Profile.updateOne(
      { _id: profileId },
      { $pull: { webPushSubscriptions: { endpoint: { $in: staleEndpoints } } } }
    );
  }

  return { successCount, failureCount };
}

module.exports = {
  getVapidPublicKey,
  isWebPushReady,
  sendWebPushToProfile,
  ensureConfigured,
};
