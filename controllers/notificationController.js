const { mongoose } = require("mongoose");
const Notification = require("../models/Notification");
const Profile = require("../models/Profile");
const { sendPushToProfile } = require("../utils/pushNotifications");
const { sendWebPushToProfile } = require("../utils/webPush");
const { getPostId, postLink } = require("../utils/getPostId");

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
    let notificaitons = await Notification.find({ receiverId: profileId })
      .limit(25)
      .sort({ timestamp: -1 });
    // console.log(notificaitons)
    io.to(profileId).emit("oldNotifications", notificaitons.reverse());
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

  let notification = new Notification({
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
  });
  let newNotification = await notification.save();

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
    sendWebPushToProfile(receiverId, {
      title: notificationTitle,
      body: notificationText,
      text: notificationText,
      icon: notificationIcon || "/apple-touch-icon.png",
      link: notificationLink,
      type: notificationType,
      tag: `connect-${String(dedupeId)}`,
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
  let notification = new Notification({
    receiverId,
    text: notificationText,
    link: notificationLink,
    icon: notificationIcon,
    type: notificationType,
  });

  let newNotification = await notification.save();
  if (newNotification) {
    return res.json({ message: "New Notification Created" }).json(200);
  }
  return res.json({ message: "Notification Creation Failed" }).json(400);
};

exports.notificationView = async (req, res, next) => {
  let notificationId = req.body.notificationId;

  if (!mongoose.isValidObjectId(notificationId)) return next();

  let updatedNotification = await Notification.findOneAndUpdate(
    { _id: notificationId },
    {
      isSeen: true,
    },
    { new: true },
  );

  if (updatedNotification) {
    return res
      .json({ message: "Notification status updated successfully" })
      .status(200);
  }
  res.json({ message: "Something went wrong" }).status(400);
};
exports.notificationViewAll = async (req, res, next) => {
  let profile = req.profile;

  let updatedNotification = await Notification.updateMany(
    { receiverId: profile._id },
    {
      isSeen: true,
    },
    { new: true },
  );

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
  let notifications = await Notification.find({
    receiverId: receverId,
    type: { $ne: "message" },
  })
    .select("receiverId text title icon link type data isSeen timestamp")
    .limit(limit)
    .sort({ timestamp: -1 })
    .lean();
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

    const notifications = await Notification.find({
      receiverId: profileId,
      isSeen: false,
      type: { $ne: "message" },
    })
      .select("receiverId text title icon link type data isSeen timestamp")
      .limit(20)
      .sort({ timestamp: -1 })
      .lean();

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

    if (!mongoose.isValidObjectId(notificationId)) {
      return res.status(400).json({ message: "Invalid notification id" });
    }

    const deleted = await Notification.findOneAndDelete({
      _id: notificationId,
      receiverId: profileId,
    });

    if (!deleted) {
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

    const filter = {
      receiverId: profileId,
      type: "ludo_invite",
      "data.gameId": String(gameId),
    };
    if (inviterId) {
      filter["data.inviterId"] = String(inviterId);
    }

    const result = await Notification.deleteMany(filter);

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

    const filter = {
      receiverId: profileId,
      type: "chess_invite",
      "data.gameId": String(gameId),
    };
    if (inviterId) {
      filter["data.inviterId"] = String(inviterId);
    }

    const result = await Notification.deleteMany(filter);

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
    let deletedNotification = await Notification.deleteMany({
      receiverId: profileId,
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

// Register a device token to the authenticated profile
exports.registerDeviceToken = async (req, res, next) => {
  try {
    const token = (req.body?.token || "").trim();
    if (!token) return res.status(400).json({ message: "Token is required" });

    const profileId = req.profile._id;
    const updated = await Profile.findByIdAndUpdate(
      profileId,
      { $addToSet: { deviceTokens: token } },
      { new: true },
    ).select("deviceTokens");

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

    const profileId = req.profile._id;
    const updated = await Profile.findByIdAndUpdate(
      profileId,
      { $pull: { deviceTokens: token } },
      { new: true },
    ).select("deviceTokens");

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

    const profile = await Profile.findById(profileId);
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

    await profile.save({ validateBeforeSave: false });

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
          friendId: calleeId,
          channelName,
        });
      } else {
        io.to(callerId).emit("video-call-rejected", {
          to: callerId,
          friendId: calleeId,
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
