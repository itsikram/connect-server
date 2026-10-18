const { randomUUID } = require('crypto');
const { prisma, populated } = require('./db');
const sendEmailNotification = require('./sendEmailNotification');
const { getUserPrefs } = require('./notificationPrefs');

const DEFAULT_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_MAX_GROUPS_PER_RUN = 20;

let workerInterval = null;
let isRunning = false;

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getClientAppUrl = () => {
  const url = (
    process.env.CLIENT_URL ||
    process.env.REACT_APP_URL ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');

  if (process.env.NODE_ENV === 'production' && /localhost|127\.0\.0\.1/i.test(url)) {
    console.warn(
      `[unseen-reminder] CLIENT_URL is "${url}" in production. ` +
        'Set CLIENT_URL to your live web app URL so reminder emails link correctly.'
    );
  }

  return url;
};

const buildMessagePreview = (messageDoc) => {
  const text = String(messageDoc?.message || '').trim();
  if (text) {
    return text.length > 140 ? `${text.slice(0, 137)}...` : text;
  }

  if (messageDoc?.messageType === 'audio') {
    return 'Sent you a voice message';
  }

  if (messageDoc?.attachment) {
    return 'Sent you an attachment';
  }

  return 'Sent you a message';
};

const buildReminderEmail = ({ senderName, receiverName, unreadCount, latestPreview, chatUrl }) => {
  const safeSenderName = senderName || 'Someone';
  const safeReceiverName = receiverName || 'there';
  const countText = unreadCount === 1 ? '1 unread message' : `${unreadCount} unread messages`;
  const subject =
    unreadCount === 1
      ? `${safeSenderName} sent you a message on Connect`
      : `${safeSenderName} sent you ${unreadCount} messages on Connect`;

  const textLines = [
    `Hi ${safeReceiverName},`,
    '',
    `You have ${countText} from ${safeSenderName} on Connect.`,
    '',
    `Latest message: "${latestPreview}"`,
  ];

  if (chatUrl) {
    textLines.push('', `Open chat: ${chatUrl}`);
  }

  textLines.push('', 'If you already saw the message, you can ignore this email.');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="margin: 0 0 12px; font-size: 22px;">You have ${escapeHtml(countText)}</h2>
      <p style="margin: 0 0 16px;">Hi ${escapeHtml(safeReceiverName)},</p>
      <p style="margin: 0 0 16px;">
        ${escapeHtml(safeSenderName)} sent you ${unreadCount === 1 ? 'a message' : `${unreadCount} messages`} on Connect.
      </p>
      <div style="background: #f3f4f6; border-radius: 12px; padding: 16px; margin: 0 0 20px;">
        <div style="font-size: 13px; color: #6b7280; margin-bottom: 6px;">Latest message</div>
        <div style="font-size: 15px; color: #111827;">${escapeHtml(latestPreview)}</div>
      </div>
      ${
        chatUrl
          ? `<a href="${escapeHtml(chatUrl)}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 10px; font-weight: 600;">Open chat</a>`
          : ''
      }
      <p style="margin: 20px 0 0; font-size: 13px; color: #6b7280;">
        If you already saw the message, you can ignore this email.
      </p>
    </div>
  `;

  return {
    subject,
    text: textLines.join('\n'),
    html,
  };
};

const reminderEligibilityFilter = (cutoffDate, staleLockDate) => ({
  isSeen: false,
  messageType: { not: 'call' },
  timestamp: { lte: cutoffDate },
  unseenReminderEmailSentAt: null,
  OR: [
    { unseenReminderEmailProcessingAt: null },
    { unseenReminderEmailProcessingAt: { lte: staleLockDate } },
  ],
});

const findProfileWithUser = (id) =>
  prisma.profile
    .findUnique({
      where: { id: String(id) },
      select: {
        id: true,
        fullName: true,
        user: true,
        userDoc: { select: { id: true, firstName: true, surname: true, email: true } },
      },
    })
    .then((row) => populated(row, 'user'));

const clearProcessingState = async (messageIds, extraSet = {}) => {
  if (!messageIds.length) return;

  await prisma.message.updateMany({
    where: { id: { in: messageIds } },
    data: {
      unseenReminderEmailProcessingKey: null,
      unseenReminderEmailProcessingAt: null,
      ...extraSet,
    },
  });
};

const processReminderGroup = async ({ senderId, receiverId, cutoffDate, staleLockDate }) => {
  if (!senderId || !receiverId || String(senderId) === String(receiverId)) {
    return;
  }

  // "New Message Received" email is off: settle these messages without emailing.
  const receiverPrefs = await getUserPrefs(receiverId);
  if (!receiverPrefs.newMessageReceivedEmail) {
    await prisma.message.updateMany({
      where: {
        ...reminderEligibilityFilter(cutoffDate, staleLockDate),
        senderId: String(senderId),
        receiverId: String(receiverId),
      },
      data: {
        unseenReminderEmailSentAt: new Date(),
        unseenReminderEmailLastError: 'Email reminders turned off by receiver',
      },
    });
    return;
  }

  const processingKey = randomUUID();
  const processingAt = new Date();

  const claimResult = await prisma.message.updateMany({
    where: {
      ...reminderEligibilityFilter(cutoffDate, staleLockDate),
      senderId: String(senderId),
      receiverId: String(receiverId),
    },
    data: {
      unseenReminderEmailProcessingKey: processingKey,
      unseenReminderEmailProcessingAt: processingAt,
      unseenReminderEmailLastError: null,
    },
  });

  if (!claimResult.count) {
    return;
  }

  const claimedMessages = await prisma.message.findMany({
    where: {
      senderId: String(senderId),
      receiverId: String(receiverId),
      unseenReminderEmailProcessingKey: processingKey,
    },
    orderBy: { timestamp: 'asc' },
  });

  if (!claimedMessages.length) {
    return;
  }

  const messageIds = claimedMessages.map((message) => message.id);

  try {
    const [senderProfile, receiverProfile] = await Promise.all([
      findProfileWithUser(senderId),
      findProfileWithUser(receiverId),
    ]);

    const receiverEmail = receiverProfile?.user?.email?.trim();
    if (!receiverEmail) {
      await clearProcessingState(messageIds, {
        unseenReminderEmailLastError: 'Recipient email unavailable',
      });
      return;
    }

    const senderName =
      senderProfile?.fullName ||
      [senderProfile?.user?.firstName, senderProfile?.user?.surname].filter(Boolean).join(' ') ||
      'Someone';

    const receiverName =
      receiverProfile?.fullName ||
      [receiverProfile?.user?.firstName, receiverProfile?.user?.surname].filter(Boolean).join(' ') ||
      'there';

    const latestMessage = claimedMessages[claimedMessages.length - 1];
    const latestPreview = buildMessagePreview(latestMessage);
    const unreadCount = claimedMessages.length;
    const chatUrl = `${getClientAppUrl()}/message/${senderId}`;

    const email = buildReminderEmail({
      senderName,
      receiverName,
      unreadCount,
      latestPreview,
      chatUrl,
    });

    await sendEmailNotification(receiverEmail, email.subject, email.text, 'Connect', {
      html: email.html,
      throwOnError: true,
    });

    await prisma.message.updateMany({
      where: {
        id: { in: messageIds },
        unseenReminderEmailProcessingKey: processingKey,
      },
      data: {
        unseenReminderEmailSentAt: new Date(),
        unseenReminderEmailProcessingKey: null,
        unseenReminderEmailProcessingAt: null,
        unseenReminderEmailLastError: null,
      },
    });
  } catch (error) {
    const errorMessage = error?.message || String(error);
    console.error(
      `[unseen-reminder] Failed for sender=${senderId} receiver=${receiverId}:`,
      errorMessage
    );

    await clearProcessingState(messageIds, {
      unseenReminderEmailLastError:
        errorMessage.length > 500 ? `${errorMessage.slice(0, 497)}...` : errorMessage,
    });
  }
};

const runUnseenMessageReminderScan = async () => {
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    const reminderDelayMs = Number(process.env.UNSEEN_MESSAGE_REMINDER_DELAY_MS) || DEFAULT_DELAY_MS;
    const staleLockMs = Number(process.env.UNSEEN_MESSAGE_REMINDER_STALE_LOCK_MS) || DEFAULT_STALE_LOCK_MS;
    const maxGroupsPerRun = Number(process.env.UNSEEN_MESSAGE_REMINDER_MAX_GROUPS_PER_RUN) || DEFAULT_MAX_GROUPS_PER_RUN;

    const cutoffDate = new Date(Date.now() - reminderDelayMs);
    const staleLockDate = new Date(Date.now() - staleLockMs);

    const groups = await prisma.message.groupBy({
      by: ['senderId', 'receiverId'],
      where: reminderEligibilityFilter(cutoffDate, staleLockDate),
      take: maxGroupsPerRun,
      orderBy: [{ senderId: 'asc' }, { receiverId: 'asc' }],
    });

    for (const group of groups) {
      const senderId = group?.senderId;
      const receiverId = group?.receiverId;
      await processReminderGroup({ senderId, receiverId, cutoffDate, staleLockDate });
    }
  } catch (error) {
    console.error('[unseen-reminder] Worker run failed:', error?.message || error);
  } finally {
    isRunning = false;
  }
};

const startUnseenMessageReminderWorker = () => {
  if (process.env.DISABLE_UNSEEN_MESSAGE_REMINDERS === 'true') {
    console.log('[unseen-reminder] Worker disabled by DISABLE_UNSEEN_MESSAGE_REMINDERS=true');
    return null;
  }

  if (workerInterval) {
    return workerInterval;
  }

  const intervalMs = Number(process.env.UNSEEN_MESSAGE_REMINDER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  workerInterval = setInterval(() => {
    runUnseenMessageReminderScan().catch((error) => {
      console.error('[unseen-reminder] Unhandled worker error:', error?.message || error);
    });
  }, intervalMs);

  if (typeof workerInterval.unref === 'function') {
    workerInterval.unref();
  }

  runUnseenMessageReminderScan().catch((error) => {
    console.error('[unseen-reminder] Initial worker run failed:', error?.message || error);
  });

  console.log(`[unseen-reminder] Worker started (interval=${intervalMs}ms)`);
  return workerInterval;
};

module.exports = {
  startUnseenMessageReminderWorker,
  runUnseenMessageReminderScan,
};
