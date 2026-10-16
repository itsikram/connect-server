// Sender avatars for push notifications (native FCM / Expo and Web Push).
const { prisma, toId } = require('./db');
const config = require('../config/config.json');

/**
 * Push providers download the image themselves, so it must be an absolute
 * http(s) URL. Relative paths resolve against the web app; the generic default
 * avatar is dropped because it adds nothing to the notification.
 * @param {string} raw
 * @returns {string} absolute URL, or '' when there is no usable image
 */
function resolvePushImageUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s === config?.defaultProfile) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const base = process.env.CLIENT_URL || process.env.FRONTEND_URL;
  if (!base || !s.startsWith('/')) return '';
  try {
    return new URL(s, base).toString();
  } catch (_e) {
    return '';
  }
}

/** Profile picture of the notification's sender (data.senderId), if any. */
async function lookupSenderImage(data = {}) {
  const senderId = data.senderId || data.fromId;
  if (!senderId) return '';
  try {
    const key = toId(senderId);
    const sender = await prisma.profile.findFirst({
      where: { OR: [{ id: key }, { user: key }] },
      select: { profilePic: true },
    });
    return resolvePushImageUrl(sender?.profilePic);
  } catch (_e) {
    return '';
  }
}

module.exports = { resolvePushImageUrl, lookupSenderImage };
