const Profile = require('../models/Profile');
const { sendPushToProfile } = require('./pushNotifications');
const { sendWebPushToProfile } = require('./webPush');

const recentBumps = new Map();
const BUMP_DEDUP_MS = 3000;

const shouldEmitBump = (fromId, toId) => {
  const key = `${String(fromId)}:${String(toId)}`;
  const last = recentBumps.get(key) || 0;
  const now = Date.now();
  if (now - last < BUMP_DEDUP_MS) return false;
  recentBumps.set(key, now);
  if (recentBumps.size > 2000) {
    for (const [k, ts] of recentBumps) {
      if (now - ts > 10_000) recentBumps.delete(k);
    }
  }
  return true;
};

/**
 * Deliver a bump to a friend: realtime socket + native/web push.
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string }}
 */
async function sendBump(io, { friendProfile, myProfile }) {
  const toId = String(friendProfile || '');
  const fromId = String(myProfile || '');
  if (!toId || !fromId) {
    return { ok: false, reason: 'missing_ids' };
  }
  if (toId === fromId) {
    return { ok: false, reason: 'self' };
  }
  if (!shouldEmitBump(fromId, toId)) {
    return { ok: true, skipped: true };
  }

  const [friendProfileData, myProfileData] = await Promise.all([
    Profile.findById(toId).select('fullName profilePic'),
    Profile.findById(fromId).select('fullName profilePic'),
  ]);

  if (!myProfileData) {
    return { ok: false, reason: 'sender_not_found' };
  }

  const senderName = myProfileData.fullName || 'Someone';
  const senderPic = myProfileData.profilePic || '';
  const chatLink = `/message/${fromId}`;
  const payload = {
    type: 'bump',
    senderId: fromId,
    friendProfileData,
    myProfileData,
  };

  let recipientOnline = false;
  if (io) {
    try {
      const room = io.sockets?.adapter?.rooms?.get(toId);
      recipientOnline = !!(room && room.size > 0);
    } catch (_e) {
      recipientOnline = false;
    }
    io.to(toId).emit('bumpUser', payload);
  }

  // Online friends already got the live socket event — extra push caused
  // duplicate alerts in the open tab.
  if (!recipientOnline) {
    try {
      await sendPushToProfile(toId, {
        title: 'You were bumped!',
        body: `${senderName} bumped you`,
        data: {
          type: 'bump',
          senderId: fromId,
          callerName: senderName,
          url: chatLink,
          link: chatLink,
        },
      });
    } catch (_e) {}

    try {
      await sendWebPushToProfile(toId, {
        title: 'You were bumped!',
        body: `${senderName} bumped you`,
        type: 'bump',
        tag: `bump-${fromId}`,
        link: chatLink,
        icon: senderPic || undefined,
        sound: '/assets/audio/notification_sound.wav',
        vibrate: [80, 40, 140, 40, 80],
        urgency: 'high',
        ttl: 60,
        data: {
          type: 'bump',
          senderId: fromId,
          senderName,
          url: chatLink,
          link: chatLink,
        },
      });
    } catch (_e) {}
  }

  return { ok: true };
}

module.exports = { sendBump };
