const { isValidObjectId } = require("mongoose");
const Message = require("../models/Message");
const Profile = require("../models/Profile");
const checkIsActive = require("../utils/checkIsActive");
const updateLastActive = require("../utils/updateLastActive");
const axios = require("axios");

const {
  sendChatMessageDataPush,
  sendDataPushToProfile,
} = require("../utils/pushNotifications");
const config = require("../config/config.json");

// Track recently processed messages to prevent duplicate notifications
const recentMessageNotifications = new Map(); // messageId -> timestamp
const NOTIFICATION_DEDUP_WINDOW = 5000; // 5 seconds

module.exports = function messageSocket(io, socket, profileId) {
  // Room management for real-time messaging
  socket.on("joinRoom", (roomId) => {
    console.log(`User ${profileId} joining room: ${roomId}`);
    socket.join(roomId);
  });

  socket.on("leaveRoom", (roomId) => {
    console.log(`User ${profileId} leaving room: ${roomId}`);
    socket.leave(roomId);
  });

  socket.on("fetchMessages", async () => {
    let profileContacts = [];
    let myProfile = await Profile.findOne({ _id: profileId }).populate(
      "friends",
    );

    if (!myProfile) return;
    if (myProfile?.friends !== null) {
      for (const friendProfile of myProfile.friends) {
        // Only fetch the most recent message from each friend
        // and mark it as 'fromInitialLoad' so frontend doesn't show notification
        const messages = await Message.find({
          senderId: friendProfile._id,
          receiverId: profileId,
        })
          .limit(1)
          .sort({ timestamp: -1 });

        // Add flag to indicate these are from initial load (not real-time)
        const messagesWithFlag = messages.map((msg) => ({
          ...(msg.toObject ? msg.toObject() : msg),
          fromInitialLoad: true,
        }));

        profileContacts.push({
          person: friendProfile,
          messages: messagesWithFlag,
        });
      }
      // Emit as 'initialMessages' to distinguish from real-time 'newMessageToUser'
      // Frontend should NOT show notifications for messages with fromInitialLoad flag
      io.to(profileId).emit("initialMessages", profileContacts);
    }
  });

  socket.on("startChat", async ({ user1, user2 }) => {
    const room = [user1, user2].sort().join("_"); // Ensures consistent room ID
    socket.join(room);

    const messages = await Message.find({
      $or: [
        { senderId: user1, receiverId: user2 },
        { senderId: user2, receiverId: user1 },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(20)
      .populate("parent");
    socket.emit("previousMessages", messages.reverse());
    socket.emit("roomJoined", { room });
  });

  socket.on("loadMessages", async ({ myId, friendId, skip }) => {
    let limit = 20;
    if (skip < 1) {
      return io
        .to(myId)
        .emit("loadMessages", { loadedMessages: [], hasNewMessage: false });
    }
    const loadedMessages = await Message.find({
      $or: [
        { senderId: myId, receiverId: friendId },
        { senderId: friendId, receiverId: myId },
      ],
    })
      .skip(skip)
      .limit(limit)
      .sort({ timestamp: -1 })
      .populate("parent");
    let messagesLeft = await Message.find({
      $or: [
        { senderId: myId, receiverId: friendId },
        { senderId: friendId, receiverId: myId },
      ],
    })
      .skip(skip)
      .limit(limit)
      .sort({ timestamp: -1 });
    let hasNewMessage = messagesLeft.length < 1 ? false : true;
    let msgList = loadedMessages.reverse();
    // Note: loadMessages is for pagination, not for initial notifications
    return io
      .to(myId)
      .emit("loadMessages", { loadedMessages: msgList, hasNewMessage });
  });

  socket.on(
    "fetchOldMessages",
    async ({ room, userId, page, limit, beforeTimestamp }) => {
      try {
        console.log("fetchOldMessages received:", {
          room,
          userId,
          page,
          limit,
          beforeTimestamp,
        });

        // Parse the room to get both user IDs
        const [user1, user2] = room.split("_");

        // Build query for messages between these users before the given timestamp
        const query = {
          $or: [
            { senderId: user1, receiverId: user2 },
            { senderId: user2, receiverId: user1 },
          ],
          timestamp: { $lt: new Date(beforeTimestamp) },
        };

        // Calculate skip based on page
        const skip = (page - 1) * limit;

        // Fetch old messages
        const oldMessages = await Message.find(query)
          .sort({ timestamp: -1 })
          .skip(skip)
          .limit(limit)
          .populate("parent");

        // Check if there are more messages available
        const totalOldMessages = await Message.countDocuments(query);
        const hasMore = skip + limit < totalOldMessages;

        console.log("fetchOldMessages result:", {
          foundMessages: oldMessages.length,
          hasMore,
          totalOldMessages,
          skip,
          limit,
        });

        // Emit the old messages (pagination - should NOT trigger notifications)
        // Frontend should not create notifications for old paginated messages
        socket.emit("oldMessages", oldMessages.reverse());
      } catch (error) {
        console.error("Error fetching old messages:", error);
        // Return empty array on error - no notifications should be triggered
        socket.emit("oldMessages", []);
      }
    },
  );

  socket.on("deleteMessage", async (messageId) => {
    let deletedMessages = await Message.findOneAndDelete({ _id: messageId });
    if (deletedMessages) {
      io.to(deletedMessages.room).emit("deleteMessage", messageId);
    }
  });

  socket.on("reactMessage", async ({ messageId, profileId }) => {
    let reactedMessage = await Message.findOneAndUpdate(
      {
        _id: messageId,
        reacts: {
          $nin: profileId,
        },
      },
      {
        $push: {
          reacts: profileId,
        },
      },
      { new: true },
    );
    if (reactedMessage) {
      io.to(profileId).emit("messageReacted", messageId);
    }
  });

  socket.on("removeReactMessage", async ({ messageId, profileId }) => {
    let removedReactedMessage = await Message.findOneAndUpdate(
      { _id: messageId },
      {
        $pull: {
          reacts: profileId,
        },
      },
      { new: true },
    );

    if (removedReactedMessage) {
      io.to(profileId).emit("messageReactRemoved", messageId);
    }
  });

  socket.on(
    "speak_message",
    async ({ msgId, friendId, message, attachment, messageType } = {}) => {
      try {
        if (!friendId) return;

        const isAudioAttachmentUrl = (url) => {
          if (!url || typeof url !== "string") return false;
          const lower = url.toLowerCase();
          return (
            lower.includes(".mp3") ||
            lower.includes(".wav") ||
            lower.includes(".ogg") ||
            lower.includes(".webm") ||
            lower.includes(".m4a") ||
            lower.includes("/audio/") ||
            lower.includes("voice-")
          );
        };

        // Prefer payload values from client, fallback to DB values by msgId.
        let msgData = null;
        if (msgId) {
          try {
            msgData = await Message.findById(msgId);
          } catch (_e) {
            msgData = null;
          }
        }

        const resolvedMessageType =
          messageType ||
          msgData?.messageType ||
          (isAudioAttachmentUrl(attachment || msgData?.attachment)
            ? "audio"
            : "text");

        const resolvedAttachment =
          (typeof attachment === "string" && attachment) ||
          (typeof msgData?.attachment === "string" ? msgData.attachment : "");

        const resolvedMessage =
          (typeof message === "string" && message) ||
          (typeof msgData?.message === "string" ? msgData.message : "");

        const isAudioMessage =
          resolvedMessageType === "audio" ||
          isAudioAttachmentUrl(resolvedAttachment);

        if (!isAudioMessage && !resolvedMessage.trim()) return;
        if (isAudioMessage && !resolvedAttachment) return;

        const speakPayload = {
          type: "speak_message",
          messageType: isAudioMessage ? "audio" : "text",
          message: String(resolvedMessage || ""),
          attachment: String(resolvedAttachment || ""),
        };

        // Emit over socket for online clients (web/android).
        io.to(String(friendId)).emit("speak_message", speakPayload);

        // Also send a data-only FCM push.
        try {
          await sendDataPushToProfile(String(friendId), {
            type: "speak_message",
            messageType: speakPayload.messageType,
            message: speakPayload.message,
            attachment: speakPayload.attachment,
            priority: "high",
            interrupt: true,
          });
        } catch (e) {
          console.error("FCM speak_message send failed:", e?.message || e);
        }
      } catch (e) {
        console.error("Error in speak_message handler:", e?.message || e);
      }
    },
  );

  socket.on(
    "sendMessage",
    async ({
      room,
      senderId,
      receiverId,
      message,
      attachment,
      parent,
      isAi = false,
      messageType = "text",
      callType,
      callEvent,
      tempId,
    }) => {
      console.log("sendMessage 0");

      if (isAi) {
        try {
          const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
              model: "gpt-3.5-turbo",
              messages: [{ role: "user", content: message }],
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
            },
          );

          const reply = response.data.choices[0].message.content;
          console.log("ai reply", response.data);

          return io
            .to(room)
            .emit("newMessage", {
              reply,
              senderName: "Chat Gpt",
              senderPP: config?.logo,
            });
        } catch (error) {
          return console.error(error.response?.data || error.message);
        }
      }

      // Prevent messaging if either user has blocked the other
      try {
        const [senderProfile, receiverProfile] = await Promise.all([
          Profile.findById(senderId).select("blockedUsers"),
          Profile.findById(receiverId).select("blockedUsers"),
        ]);
        const senderBlockedReceiver = senderProfile?.blockedUsers?.some(
          (id) => String(id) === String(receiverId),
        );
        const receiverBlockedSender = receiverProfile?.blockedUsers?.some(
          (id) => String(id) === String(senderId),
        );
        if (senderBlockedReceiver || receiverBlockedSender) {
          // Inform sender the message is blocked
          io.to(String(senderId)).emit("message_blocked", {
            room,
            senderId,
            receiverId,
            reason: senderBlockedReceiver
              ? "You blocked this user"
              : "You are blocked by this user",
          });
          return;
        }
      } catch (e) {
        // If check fails, proceed to avoid false positives, but log
        console.error("block check failed", e?.message || e);
      }

      console.log("sendMessage 1");

      let newMessage;
      if (parent == false) {
        newMessage = new Message({
          room,
          senderId,
          receiverId,
          message,
          attachment,
          messageType,
          callType,
          callEvent,
          tempId,
        });
      } else {
        newMessage = new Message({
          room,
          senderId,
          receiverId,
          message,
          attachment,
          parent,
          messageType,
          callType,
          callEvent,
          tempId,
        });
      }
      await newMessage.save();

      // Update last active time for sending message
      await updateLastActive(senderId);

      let updatedMessage = await Message.findOne({
        _id: newMessage._id,
      }).populate("parent");
      let profileData = await Profile.findById(senderId).populate("user");
      if (!profileData) return;
      let senderName =
        profileData.user?.firstName + " " + profileData.user?.surname;
      let senderPP = profileData.profilePic || config?.defaultProfile;

      // Enrich message object with sender info for consistency
      updatedMessage.senderName = senderName;
      updatedMessage.senderPP = senderPP;

      io.to(room).emit("newMessage", {
        updatedMessage,
        senderName,
        senderPP,
        chatPage: true,
        isRealTime: true,
      });

      let friendProfile = await Profile.findById(senderId).populate("user");
      // Emit newMessageToUser only for real-time messages (isRealTime: true)
      // This ensures the receiver gets notification only when a NEW message arrives
      io.to(receiverId).emit("newMessageToUser", {
        updatedMessage,
        senderName,
        senderPP,
        chatPage: false,
        friendProfile,
        isRealTime: true, // Flag indicates this is a real-time notification, not from initial load
      });

      let receiverProfile = await Profile.findById(receiverId).populate("user");

      let { isActive, lastLogin } = await checkIsActive(receiverId);

      // Only send notifications for real-time messages, not for old/cached messages
      // This prevents notification spam when opening the app
      console.log("sendMessage 2");
      // Outbound notifications (FCM + web + email fallback) — not for self-messages
      // Only send notifications if receiver is not the sender
      if (String(receiverId) !== String(senderId)) {
        try {
          console.log("sendMessage 3");
          const messageId = String(updatedMessage._id);
          const now = Date.now();
          const lastNotificationTime =
            recentMessageNotifications.get(messageId);

          if (
            lastNotificationTime &&
            now - lastNotificationTime < NOTIFICATION_DEDUP_WINDOW
          ) {
            console.log(
              `Skipping duplicate notification for message ${messageId} (sent ${now - lastNotificationTime}ms ago)`,
            );
          } else {
            recentMessageNotifications.set(messageId, now);

            for (const [
              msgId,
              timestamp,
            ] of recentMessageNotifications.entries()) {
              if (now - timestamp > NOTIFICATION_DEDUP_WINDOW) {
                recentMessageNotifications.delete(msgId);
              }
            }

            // 1) Mobile FCM first (independent of saveNotification / web)
            let fcmResult = { successCount: 0, failureCount: 0 };
            if (friendProfile) {
              try {
                fcmResult = await sendChatMessageDataPush(receiverId, {
                  senderId,
                  updatedMessage,
                  senderName,
                  senderPP,
                  friendProfile,
                  room,
                });
                console.log("[FCM chat] sendMessage push result", {
                  receiverId: String(receiverId),
                  senderId: String(senderId),
                  messageId: String(updatedMessage?._id),
                  successCount: fcmResult?.successCount,
                  failureCount: fcmResult?.failureCount,
                });
              } catch (e) {
                console.error(
                  "[FCM chat] sendMessage push failed:",
                  e?.message || e,
                );
              }
            } else {
              console.warn("[FCM chat] skipped — friendProfile missing");
            }

            // 2) Web: persist + socket to browsers
            const {
              saveNotification,
            } = require("../controllers/notificationController");
            const activeBrowserIds =
              receiverProfile?.browserIds
                ?.filter((browser) => browser.isActive)
                ?.map((browser) => browser.browserId) || [];

            const notificationData = {
              receiverId: receiverId,
              text: `${senderName}: ${updatedMessage.message}`,
              link: `/message/${senderId}`,
              icon: senderPP,
              type: "message",
              browserIds: activeBrowserIds,
              data: {
                senderId: senderId,
                messageId: updatedMessage._id,
                room: room,
                senderName: senderName,
                senderProfilePic: senderPP,
              },
            };

            try {
              await saveNotification(io, notificationData);
            } catch (saveErr) {
              console.error(
                "saveNotification failed:",
                saveErr?.message || saveErr,
              );
            }
          }
          console.log("sendMessage 5");
        } catch (error) {
          console.log("sendMessage 6");
          console.error("Error sending web notification for message:", error);
        }
      }
      console.log("sendMessage 7");

      if (!isActive && String(receiverId) !== String(senderId)) {
        // Try push notification first; fallback to email if none sent
      }
    },
  );

  // Unified handler to emit emotion change to one, many, or all friends
  async function handleEmotionChange(payload) {
    const {
      profileId,
      emotion,
      friendId,
      friendIds,
      broadcast,
      emotionText,
      emoji,
      confidence,
      quality,
      expression,
      expressionData,
      detectedExpressions,
      emotionScores,
    } = payload || {};
    console.log(
      "emotion_change",
      profileId,
      emotion,
      friendId || friendIds || (broadcast ? "broadcast" : null),
      emotionText,
      emoji,
      confidence,
      quality,
      expression,
    );

    try {
      if (!profileId || !emotion) {
        console.error("Missing required parameters for emotion_change:", {
          profileId,
          emotion,
        });
        return;
      }

      const updateProfile = await Profile.findOneAndUpdate(
        { _id: profileId },
        {
          lastEmotion: emotion,
          lastEmotionText: emotionText || emotion,
          lastEmotionEmoji: emoji,
          lastEmotionConfidence: confidence,
          lastEmotionQuality: quality,
        },
        { new: true },
      );

      if (!updateProfile) {
        console.error(
          "Failed to update profile for emotion_change:",
          profileId,
        );
        return;
      }

      // Resolve target recipients
      let targets = [];
      if (Array.isArray(friendIds) && friendIds.length > 0) {
        console.log("friendIds.map(String)", friendIds.map(String));
        targets = friendIds.map(String);
      } else if (friendId && friendId !== "all") {
        targets = [String(friendId)];
      } else {
        // broadcast to all friends
        const me = await Profile.findById(profileId).select("friends");
        if (me?.friends && me.friends.length > 0) {
          targets = me.friends.map((id) => String(id));
        }
      }

      if (!targets || targets.length === 0) {
        console.warn("No targets resolved for emotion_change");
        return;
      }

      const data = {
        profileId: updateProfile._id,
        emotion: updateProfile.lastEmotion,
        emotionText: updateProfile.lastEmotionText,
        emoji: updateProfile.lastEmotionEmoji,
        confidence: updateProfile.lastEmotionConfidence,
        quality: updateProfile.lastEmotionQuality,
        // Include expression data from payload (forward to clients)
        expression: expression || "none",
        expressionData: expressionData || {},
        detectedExpressions: detectedExpressions || [],
        emotionScores: emotionScores || {},
        timestamp: new Date(),
      };

      // Emit to each target room (friend profileId is used as room)
      targets.forEach((toId) => {
        try {
          io.to(toId).emit("emotion_change", data);
        } catch (e) {
          console.error(
            "Emit emotion_change failed for",
            toId,
            e?.message || e,
          );
        }
      });

      console.log(
        `Emotion change emitted to ${targets.length} friend(s):`,
        updateProfile.lastEmotion,
      );
    } catch (error) {
      console.error("Error in emotion_change handler:", error);
    }
  }

  socket.on("emotion_change", handleEmotionChange);
  // Back-compat alias some clients may send
  socket.on("change_emotion", handleEmotionChange);

  socket.on(
    "typing",
    async ({ room, isTyping, type, receiverId, senderId }) => {
      console.log("typing", room, isTyping, type, receiverId);
      if (isTyping) {
        socket.to(room).emit("typing", { receiverId, isTyping: true, type });
        // Update last active time for typing activity (only when actively typing)
        // Use senderId from event or fallback to profileId from socket context
        const activeProfileId = senderId || profileId;
        if (activeProfileId) {
          await updateLastActive(activeProfileId);
        }
      } else {
        socket.to(room).emit("typing", { receiverId, isTyping: false });
      }
      // socket.to(room).emit('typing');
    },
  );

  socket.on("update_type", ({ room, type }) => {
    io.to(room).emit("update_type", { type });
  });

  socket.on("seenMessage", async (message) => {
    // let msgId = message._id;
    if (message?._id) {
      let msg = await Message.findOneAndUpdate(
        { _id: message._id },
        { isSeen: true },
        { new: true },
      );
      if (msg) {
        io.to(message.room).emit("seenMessage", msg);
        // Update last active time for viewing messages (use profileId from socket context)
        if (profileId) {
          await updateLastActive(profileId);
        }
      }
    }
  });

  socket.on("last_emotion", async ({ friendId, profileId }) => {
    if (!isValidObjectId(friendId) && !isValidObjectId(profileId)) return;

    let profileData = await Profile.findOne({ _id: friendId }).select(
      "lastEmotion",
    );
    if (profileData) {
      io.to(profileId).emit("last_emotion", profileData);
    }
  });

  // Live voice relays (push-to-talk over Agora)
  socket.on("live-voice-start", ({ to, channelName }) => {
    try {
      io.to(to).emit("live-voice-start", { from: profileId, channelName });
    } catch (e) {
      console.error("live-voice-start relay failed:", e?.message || e);
    }
  });

  socket.on("live-voice-stop", ({ to, channelName }) => {
    try {
      io.to(to).emit("live-voice-stop", { from: profileId, channelName });
    } catch (e) {
      console.error("live-voice-stop relay failed:", e?.message || e);
    }
  });
};
