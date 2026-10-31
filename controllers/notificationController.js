const { prisma, isValidId, jsonArray } = require("../utils/db");
const { wantsPushForType } = require("../utils/notificationPrefs");
const { isMySQLReady } = require("../config/prisma");
const { sendPushToProfile } = require("../utils/pushNotifications");
const { sendWebPushToProfile } = require("../utils/webPush");
const { getPostId, postLink } = require("../utils/getPostId");

const NOTIFICATION_SELECT = {
  id: true,
  _id: true,
  receiverId: true,
  text: true,
  title: true,
  icon: true,
  link: true,
  type: true,
  data: true,
  isSeen: true,
  timestamp: true,
};

// Ludo / chess invite filter on the Json `data` column ("data.gameId" in Mongo).
function inviteFilter(profileId, type, gameId, inviterId) {
  const and = [{ data: { path: "$.gameId", equals: String(gameId) } }];
  if (inviterId) and.push({ data: { path: "$.inviterId", equals: String(inviterId) } });
  return { receiverId: String(profileId), type, AND: and };
}

const VALID_POST_LINK = /^\/post\/([a-f0-9]{24})$/i;
const OBJECT_ID_IN_TEXT = /([a-f0-9]{24})/i;

function sanitizeNotificationLink(link, data = {}) {
  if (!link || typeof link !== "string") return "/";

  if (VALID_POST_LINK.test(link)) return link;

  const postId = getPostId(data.postId);
  if (link.startsWith("/post/") && /^[a-f0-9]{24}$/i.test(postId)) {
    return postLink(postId);
  }

  if (link.startsWith("/post/")) {
    const match = link.match(OBJECT_ID_IN_TEXT);
    if (match) return `/post/${match[1]}`;
  }

  return link;
}

exports.notificationSocket = async (io, socket) => {
  socket.on("fetchNotifications", async (profileId) => {
    // Clients can emit this while MongoDB is still connecting; with
    // bufferCommands disabled the query throws, and an unhandled rejection
    // here used to crash the whole API process.
    if (!profileId || !isMySQLReady()) return;
    try {
      let notificaitons = await prisma.notification.findMany({
        where: { receiverId: String(profileId) },
        take: 25,
        orderBy: { timestamp: "desc" },
      });
      io.to(profileId).emit("oldNotifications", notificaitons.reverse());
    } catch (err) {
      console.error("[fetchNotifications] failed:", err.message);
    }
  });

  return () => {
    socket.off("fetchNotifications");
  };
};

exports.saveNotification = async (io, data) => {
  try {
  let receiverId = data?.receiverId != null ? String(data.receiverId) : "";
  if (!receiverId) return null;
  let notificationText = data.text || "";
  let notificationLink = sanitizeNotificationLink(
    data.link || "/",
    data.data || {},
  );
  let notificationIcon = data.icon || null;
  let notificationType = data.type || null;
  let browserIds = data.browserIds || [];
  let notificationTitle = data.title || "Connect";

  let newNotification = await prisma.notification.create({
    data: {
      receiverId,
      text: notificationText,
      title: notificationTitle,
      link: notificationLink,
      icon: notificationIcon,
      type: notificationType,
      data: {
        ...(data.data || {}),
        browserIds: browserIds,
      },
    },
  });

  if (newNotification) {
    if (io && typeof io.to === "function") {
      io.to(receiverId).emit("newNotification", newNotification);

      if (browserIds.length > 0) {
        browserIds.forEach((browserId) => {
          io.to(`browser_${browserId}`).emit(
            "browserNotification",
            newNotification,
          );
        });
      }
    }

    const dedupeId =
      data.data?.messageId ||
      newNotification?._id ||
      `${notificationType || "n"}-${Date.now()}`;
    const pushBody = data.pushBody || notificationText;
    // The bell feed always gets the notification; the OS push follows the
    // receiver's Notification settings.
    const pushAllowed = await wantsPushForType(receiverId, notificationType);
    if (pushAllowed) sendWebPushToProfile(receiverId, {
      title: notificationTitle,
      body: pushBody,
      text: pushBody,
      icon: notificationIcon || "/apple-touch-icon.png",
      link: notificationLink,
      type: notificationType,
      tag: data.pushTag || `connect-${String(dedupeId)}`,
      data: data.data || {},
    }).catch((err) => {
      console.warn(
        "[web-push] saveNotification push failed:",
        err?.message || err,
      );
    });
  }
  } catch (err) {
    console.error("saveNotification failed:", err);
    return null;
  }
};

exports.postNotification = async (req, res, next) => {
  let receiverId = req.body.receiverId;
  let notificationText = req.body.text;
  let notificationLink = req.body.link || "/";
  let notificationIcon = req.body.icon || null;
  let notificationType = req.body.type || null;
  let newNotification = await prisma.notification.create({
    data: {
      receiverId: receiverId == null ? null : String(receiverId),
      text: notificationText,
      link: notificationLink,
      icon: notificationIcon,
      type: notificationType,
    },
  });
  if (newNotification) {
    return res.json({ message: "New Notification Created" }).json(200);
  }
  return res.json({ message: "Notification Creation Failed" }).json(400);
};

exports.notificationView = async (req, res, next) => {
  let notificationId = req.body.notificationId;

  if (!isValidId(notificationId)) return next();

  let updatedNotification = await prisma.notification.updateMany({
    where: { id: String(notificationId) },
    data: { isSeen: true },
  });

  if (updatedNotification.count > 0) {
    return res
      .json({ message: "Notification status updated successfully" })
      .status(200);
  }
  res.json({ message: "Something went wrong" }).status(400);
};
exports.notificationViewAll = async (req, res, next) => {
  let profile = req.profile;

  let updatedNotification = await prisma.notification.updateMany({
    where: { receiverId: String(profile._id) },
    data: { isSeen: true },
  });

  if (updatedNotification) {
    return res
      .json({ message: "Notification status updated successfully" })
      .status(200);
  }
  res.json({ message: "Something went wrong" }).status(400);
};

exports.getNotifications = async (req, res, next) => {
  // Notification feeds are user-specific and must always be revalidated.
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });

  let receverId = req.query.receverId || req.query.profileId || req.profile._id;
  let limit = Math.min(Number(req.query.limit) || 50, 100);
  // Mongo's $ne also matched documents without a type.
  let notifications = await prisma.notification.findMany({
    where: {
      receiverId: String(receverId),
      OR: [{ type: null }, { type: { not: "message" } }],
    },
    select: NOTIFICATION_SELECT,
    take: limit,
    orderBy: { timestamp: "desc" },
  });
  if (notifications) {
    return res.status(200).json(notifications);
  }
  return res.status(400).json({ message: "Failed to get notificaiton" });
};

// HTTP-based new notifications polling
exports.getNewNotifications = async (req, res, next) => {
  try {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    const { profileId } = req.query;

    if (!profileId) {
      return res.status(400).json({ notifications: [] });
    }

    const notifications = await prisma.notification.findMany({
      where: {
        receiverId: String(profileId),
        isSeen: false,
        OR: [{ type: null }, { type: { not: "message" } }],
      },
      select: NOTIFICATION_SELECT,
      take: 20,
      orderBy: { timestamp: "desc" },
    });

    return res.status(200).json({ notifications });
  } catch (error) {
    console.error("Error fetching new notifications:", error);
    return res.status(500).json({ notifications: [] });
  }
};

exports.deleteNotification = async (req, res, next) => {
  try {
    const notificationId = req.body.notificationId;
    const profileId = req.profile?._id;

    if (!isValidId(notificationId)) {
      return res.status(400).json({ message: "Invalid notification id" });
    }

    const deleted = await prisma.notification.deleteMany({
      where: { id: String(notificationId), receiverId: String(profileId) },
    });

    if (!deleted.count) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.status(200).json({ message: "Notification deleted" });
  } catch (error) {
    console.error("Error deleting notification:", error);
    return res.status(500).json({ message: "Failed to delete notification" });
  }
};

// Resolve (delete) any pending Ludo invite notifications for this profile once
// the invite has been accepted or declined - invitation alerts/notifications
// should only ever be visible before the invite is resolved.
exports.resolveLudoInviteNotifications = async (req, res, next) => {
  try {
    const profileId = req.profile?._id;
    const gameId = req.body?.gameId;
    const inviterId = req.body?.inviterId;

    if (!profileId) {
      return res.status(400).json({ message: "Profile required" });
    }
    if (!gameId) {
      return res.status(400).json({ message: "gameId is required" });
    }

    const filter = inviteFilter(profileId, "ludo_invite", gameId, inviterId);
    const deleted = await prisma.notification.deleteMany({ where: filter });
    const result = { deletedCount: deleted.count };

    return res.status(200).json({
      message: "Ludo invite notifications resolved",
      deletedCount: result?.deletedCount || 0,
    });
  } catch (error) {
    console.error("Error resolving ludo invite notifications:", error);
    return res
      .status(500)
      .json({ message: "Failed to resolve ludo invite notifications" });
  }
};

exports.resolveChessInviteNotifications = async (req, res, next) => {
  try {
    const profileId = req.profile?._id;
    const gameId = req.body?.gameId;
    const inviterId = req.body?.inviterId;

    if (!profileId) {
      return res.status(400).json({ message: "Profile required" });
    }
    if (!gameId) {
      return res.status(400).json({ message: "gameId is required" });
    }

    const filter = inviteFilter(profileId, "chess_invite", gameId, inviterId);
    const deleted = await prisma.notification.deleteMany({ where: filter });
    const result = { deletedCount: deleted.count };

    return res.status(200).json({
      message: "Chess invite notifications resolved",
      deletedCount: result?.deletedCount || 0,
    });
  } catch (error) {
    console.error("Error resolving chess invite notifications:", error);
    return res
      .status(500)
      .json({ message: "Failed to resolve chess invite notifications" });
  }
};

exports.deleteAllNotifications = async (req, res, next) => {
  try {
    const profileId = req.profile?._id || req.body.profile;
    if (!profileId) {
      return res.status(400).json({ message: "Profile required" });
    }
    let deletedNotification = await prisma.notification.deleteMany({
      where: { receiverId: String(profileId) },
    });
    if (deletedNotification) {
      return res.status(200).json({
        message: "All Notifications Are deleted",
      });
    }
    return res.status(400).json({ message: "Failed to delete notifications" });
  } catch (error) {
    console.error("Error deleting notifications:", error);
    return res.status(500).json({ message: "Failed to delete notifications" });
  }
};

// Read-modify-write of the Profile.deviceTokens Json array.
async function updateDeviceTokens(profileId, change) {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { deviceTokens: true },
  });
  if (!profile) return null;
  const deviceTokens = change(jsonArray(profile.deviceTokens));
  await prisma.profile.update({ where: { id: profileId }, data: { deviceTokens } });
  return { deviceTokens };
}

// Register a device token to the authenticated profile
exports.registerDeviceToken = async (req, res, next) => {
  try {
    const token = (req.body?.token || "").trim();
    if (!token) return res.status(400).json({ message: "Token is required" });

    const profileId = String(req.profile._id);
    const updated = await updateDeviceTokens(profileId, (tokens) =>
      tokens.includes(token) ? tokens : [...tokens, token],
    );

    return res
      .status(200)
      .json({
        message: "Token registered",
        deviceTokens: updated?.deviceTokens || [],
      });
  } catch (err) {
    next(err);
  }
};

// Unregister a device token from the authenticated profile
exports.unregisterDeviceToken = async (req, res, next) => {
  try {
    const token = (req.body?.token || "").trim();
    if (!token) return res.status(400).json({ message: "Token is required" });

    const profileId = String(req.profile._id);
    const updated = await updateDeviceTokens(profileId, (tokens) =>
      tokens.filter((t) => t !== token),
    );

    return res
      .status(200)
      .json({
        message: "Token unregistered",
        deviceTokens: updated?.deviceTokens || [],
      });
  } catch (err) {
    next(err);
  }
};

// Unregister all device tokens except the current one (if provided)
exports.unregisterAllOtherDeviceTokens = async (req, res, next) => {
  try {
    const profileId = req.profile._id;
    const currentToken = (req.body?.currentToken || "").trim();

    const row = await prisma.profile.findUnique({
      where: { id: String(profileId) },
      select: { id: true, deviceTokens: true },
    });
    const profile = row && { ...row, deviceTokens: jsonArray(row.deviceTokens) };
    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    // If currentToken is provided, keep it; otherwise, remove all tokens
    const previousCount = profile.deviceTokens?.length || 0;
    if (currentToken) {
      // Remove all tokens except the current one
      profile.deviceTokens = profile.deviceTokens.filter(
        (token) => token === currentToken,
      );
    } else {
      // Remove all tokens
      profile.deviceTokens = [];
    }

    const remainingCount = profile.deviceTokens?.length || 0;
    const unregisteredCount = previousCount - remainingCount;

    await prisma.profile.update({
      where: { id: profile.id },
      data: { deviceTokens: profile.deviceTokens },
    });

    return res.status(200).json({
      message: "All other device tokens unregistered",
      deviceTokens: profile.deviceTokens || [],
      remainingCount: remainingCount,
      unregisteredCount: unregisteredCount,
    });
  } catch (err) {
    next(err);
  }
};

// Optional: send a test push to the authenticated user
exports.sendTestPush = async (req, res, next) => {
  try {
    const profileId = req.profile._id;
    const {
      title = "Test Notification",
      body = "This is a test",
      data = {},
    } = req.body || {};
    const result = await sendPushToProfile(profileId, {
      title,
      body,
      data,
      force: true,
    });
    return res.status(200).json({ message: "Sent", result });
  } catch (err) {
    next(err);
  }
};

/**
 * Reject an incoming call when the callee presses Decline on the push (app killed — no socket).
 * Authenticated callee emits the same socket events as `video-call-reject` / `audio-call-reject`.
 */
exports.rejectIncomingCallFromPush = async (req, res, next) => {
  try {
    const io = req.app.get("io");
    const calleeId = String(req.profile._id);
    const callerId = String(req.body?.callerId || "").trim();
    const channelName = String(req.body?.channelName || "").trim();
    const isAudio =
      String(req.body?.isAudio || "false").toLowerCase() === "true";
    if (!callerId || !channelName) {
      return res
        .status(400)
        .json({ message: "callerId and channelName are required" });
    }
    if (io) {
      if (isAudio) {
        io.to(callerId).emit("audio-call-rejected", {
          to: callerId,
          connectId: calleeId,
          channelName,
        });
      } else {
        io.to(callerId).emit("video-call-rejected", {
          to: callerId,
          connectId: calleeId,
          channelName,
        });
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/**
 * Callee’s device showed the incoming-call push (Notifee). Notify caller’s UI: same as socket `update-call-status` → `updated-call-status`.
 */
exports.notifyIncomingCallRingingFromPush = async (req, res, next) => {
  try {
    const io = req.app.get("io");
    const calleeId = String(req.profile._id);
    const callerId = String(req.body?.callerId || "").trim();
    if (!callerId) {
      return res.status(400).json({ message: "callerId is required" });
    }
    if (io) {
      io.to(callerId).emit("updated-call-status", {
        from: calleeId,
        status: "Ringing...",
      });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
};
