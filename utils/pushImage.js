// Sender avatars for push notifications (native FCM / Expo and Web Push).
const { prisma, toId } = require('./db');
const config = require('../config/config.json');

// Cloudinary profile photos are full-size uploads (often 1-2 MB). Browsers and
// the Android app give up downloading a notification icon that large, and then
// show only the app logo. Notifications draw the avatar at most ~192px, so ask
// Cloudinary for a small face-centred square instead (~10 KB).
const CLOUDINARY_PUSH_AVATAR = 'c_fill,g_face,w_192,h_192,q_auto,f_jpg';
const CLOUDINARY_UPLOAD_RE = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(v\d+\/)/i;

/** Push-sized rendition of an image URL; anything not on Cloudinary passes through. */
function pushSizedImageUrl(url) {
  return url
    .replace(/^http:\/\/res\.cloudinary\.com\//i, 'https://res.cloudinary.com/')
    // Only untransformed uploads (version right after /upload/); URLs that
    // already carry a transformation are left alone.
    .replace(CLOUDINARY_UPLOAD_RE, `$1${CLOUDINARY_PUSH_AVATAR}/$2`);
}

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
  if (/^https?:\/\//i.test(s)) return pushSizedImageUrl(s);
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
