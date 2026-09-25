// Single fan-out for "new chat message" notifications, shared by the socket
// and HTTP send paths so web and mobile always get the same alerts.
//   1) Mobile: FCM / Expo push (visible notification + tap data)
//   2) Web: bell-feed record + socket `newNotification` + Web Push (VAPID)
const Profile = require('../models/Profile');
const { sendChatMessageDataPush } = require('./pushNotifications');
const { messagePreview } = require('./messagePreview');

// messageId -> timestamp; guards against a double fan-out for one message.
const recentlyNotified = new Map();
const DEDUP_WINDOW_MS = 60 * 1000;

async function notifyNewChatMessage(io, {
  updatedMessage,
  senderId,
  receiverId,
  senderName,
  senderPP,
  senderProfile,
  room,
}) {
  if (!updatedMessage || !senderId || !receiverId) return;
  if (String(receiverId) === String(senderId)) return;

  const messageId = String(updatedMessage._id || '');
  const now = Date.now();
  for (const [id, ts] of recentlyNotified.entries()) {
    if (now - ts > DEDUP_WINDOW_MS) recentlyNotified.delete(id);
  }
  if (messageId && recentlyNotified.has(messageId)) return;
  if (messageId) recentlyNotified.set(messageId, now);

  const preview = messagePreview(updatedMessage);

  // 1) Mobile push (independent of the web path so one failing never blocks the other)
  try {
    const result = await sendChatMessageDataPush(receiverId, {
      senderId,
      updatedMessage,
      senderName,
      senderPP,
      connectProfile: senderProfile,
      room,
    });
    console.log('[FCM chat] push result', {
      receiverId: String(receiverId),
      messageId,
      successCount: result?.successCount,
      failureCount: result?.failureCount,
    });
  } catch (e) {
    console.error('[FCM chat] push failed:', e?.message || e);
  }

  // 2) Web: bell feed + socket + Web Push
  try {
    const { saveNotification } = require('../controllers/notificationController');
    const receiverProfile = await Profile.findById(receiverId).select('browserIds');
    const activeBrowserIds =
      receiverProfile?.browserIds
        ?.filter((browser) => browser.isActive)
        ?.map((browser) => browser.browserId) || [];

    await saveNotification(io, {
      receiverId,
      title: senderName,
      text: `${senderName}: ${preview}`,
      // OS notification shows the sender as the title, so the body is just the preview.
      pushBody: preview,
      // One OS notification per conversation (latest message replaces older ones).
      pushTag: `chat-${String(senderId)}`,
      link: `/message/${senderId}`,
      icon: senderPP,
      type: 'message',
      browserIds: activeBrowserIds,
      data: {
        senderId: String(senderId),
        receiverId: String(receiverId),
        messageId,
        room,
        senderName,
        senderProfilePic: senderPP,
      },
    });
  } catch (e) {
    console.error('[web chat] notification failed:', e?.message || e);
  }
}

module.exports = { notifyNewChatMessage };
