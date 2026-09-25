const { isValidObjectId } = require("mongoose");
const Message = require("../models/Message");
const Profile = require("../models/Profile");
const checkIsActive = require("../utils/checkIsActive");
const updateLastActive = require("../utils/updateLastActive");
const axios = require("axios");
const { listHasId } = require("../utils/ids");

const { sendDataPushToProfile } = require("../utils/pushNotifications");
const { notifyNewChatMessage } = require("../utils/chatNotifications");
const { senderDisplayName } = require("../utils/messagePreview");
const config = require("../config/config.json");


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
      "connects",
    );

    if (!myProfile) return;
    if (myProfile?.connects !== null) {
      for (const connectProfile of myProfile.connects) {
        // Only fetch the most recent message from each connect
        // and mark it as 'fromInitialLoad' so frontend doesn't show notification
        const messages = await Message.find({
          senderId: connectProfile._id,
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
          person: connectProfile,
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

  socket.on("loadMessages", async ({ myId, connectId, skip }) => {
    let limit = 20;
    if (skip < 1) {
      return io
        .to(myId)
        .emit("loadMessages", { loadedMessages: [], hasNewMessage: false });
    }
    const loadedMessages = await Message.find({
      $or: [
        { senderId: myId, receiverId: connectId },
        { senderId: connectId, receiverId: myId },
      ],
    })
      .skip(skip)
      .limit(limit)
      .sort({ timestamp: -1 })
      .populate("parent");
    let messagesLeft = await Message.find({
      $or: [
        { senderId: myId, receiverId: connectId },
        { senderId: connectId, receiverId: myId },
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
    try {
      if (!isValidObjectId(messageId)) return;
      // Only the sender may delete their own message.
      const deleted = await Message.findOneAndDelete({
        _id: messageId,
        senderId: String(profileId),
      });
      if (deleted) {
        io.to([
          deleted.room,
          String(deleted.senderId),
          String(deleted.receiverId),
        ].filter(Boolean)).emit("deleteMessage", String(messageId));
      }
    } catch (error) {
      console.error("deleteMessage failed:", error?.message || error);
    }
  });

  const reactionProfileId = (reaction) => String(reaction && reaction.profile ? reaction.profile : reaction || "");
  const normalizeReactions = (reactions = []) => {
    const seen = new Set();
    return (Array.isArray(reactions) ? reactions : []).reduce((result, reaction) => {
      const profile = reaction && reaction.profile ? reaction.profile : reaction;
      const id = reactionProfileId(reaction);
      if (!id || seen.has(id)) return result;
      seen.add(id);
      result.push({ profile, type: reaction && reaction.type ? reaction.type : "👍" });
      return result;
    }, []);
  };
  const updateReaction = async (messageId, reactType, remove, ack) => {
    try {
      const message = await Message.findById(messageId);
      if (!message || ![String(message.senderId), String(message.receiverId)].includes(String(profileId))) {
        if (typeof ack === "function") ack({ ok: false, error: "Message access denied" });
        return;
      }
      const reactions = normalizeReactions(message.reacts)
        .filter((reaction) => String(reaction.profile) !== String(profileId));
      if (!remove) reactions.push({ profile: profileId, type: reactType || "👍" });
      message.reacts = reactions;
      await message.save();
      const payload = { message: message.toObject(), reactions };
      io.to(message.room).emit("messageReactionUpdated", payload);
      // Also target both profile rooms so the reaction arrives when the other
      // participant has not joined the chat room yet.
      io.to(String(message.senderId)).emit("messageReactionUpdated", payload);
      io.to(String(message.receiverId)).emit("messageReactionUpdated", payload);
      if (typeof ack === "function") ack({ ok: true, ...payload });
    } catch (error) {
      console.error("Message reaction error:", error);
      if (typeof ack === "function") ack({ ok: false, error: "Unable to update reaction" });
    }
  };
  socket.on("reactMessage", (data = {}, ack) => updateReaction(data.messageId, data.reactType, false, ack));
  socket.on("removeReactMessage", (data = {}, ack) => updateReaction(data.messageId, null, true, ack));

  socket.on(
    "speak_message",
    async ({ msgId, connectId, message, attachment, messageType } = {}) => {
      try {
        const targetProfileId = connectId ? String(connectId) : "";
        const senderProfileId = profileId ? String(profileId) : "";
        if (!targetProfileId || !senderProfileId) return;
        if (targetProfileId === senderProfileId) {
          console.warn(
            `Ignoring self-targeted speak_message request from ${senderProfileId}`,
          );
          return;
        }

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
        io.to(targetProfileId).emit("speak_message", {
          ...speakPayload,
          senderId: senderProfileId,
          targetProfileId,
        });

        // Also send a data-only FCM push.
        try {
          await sendDataPushToProfile(targetProfileId, {
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

  socket.on("sendMessage", async (payload = {}, ack) => {
    const {
      room,
      senderId: payloadSenderId,
      receiverId,
      message,
      attachment,
      parent,
      isAi = false,
      messageType = "text",
      duration,
      callType,
      callEvent,
      tempId,
    } = payload;
    // The authenticated socket identity is the sender; never trust the payload
    // over it (the payload value is only a fallback for legacy clients).
    const senderId = String(profileId || payloadSenderId || "");
    // Web and Expo both derive the room as the sorted pair of profile ids.
    // Recompute it server-side so a client with a stale/malformed room can
    // never send a message the other side doesn't receive.
    const chatRoom =
      senderId && receiverId
        ? [senderId, String(receiverId)].sort().join("_")
        : room;

    const reply = (data) => {
      if (typeof ack === "function") {
        try {
          ack(data);
        } catch (_e) {
          /* ignore client disconnect during ack */
        }
      }
    };

    const serializeMessage = (doc) => {
      const obj = doc?.toObject ? doc.toObject() : doc;
      if (obj && tempId && !obj.tempId) obj.tempId = tempId;
      return obj;
    };

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

          const aiReply = response.data.choices[0].message.content;
          console.log("ai reply", response.data);

          const aiPayload = {
            reply: aiReply,
            senderName: "Chat Gpt",
            senderPP: config?.logo,
            tempId,
          };
          io.to(chatRoom).emit("newMessage", aiPayload);
          reply({ ok: true, ...aiPayload });
          return;
        } catch (error) {
          reply({ ok: false, error: error.message });
          return console.error(error.response?.data || error.message);
        }
      }

      // Prevent messaging if either user has blocked the other
      try {
        if (senderId && receiverId && String(senderId) !== String(receiverId)) {
          const [senderProfile, receiverProfile] = await Promise.all([
            Profile.findById(senderId).select("blockedUsers"),
            Profile.findById(receiverId).select("blockedUsers"),
          ]);
          const senderBlockedReceiver = listHasId(
            senderProfile?.blockedUsers,
            receiverId,
          );
          const receiverBlockedSender = listHasId(
            receiverProfile?.blockedUsers,
            senderId,
          );
          if (senderBlockedReceiver || receiverBlockedSender) {
            const blockedPayload = {
              room: chatRoom,
              senderId,
              receiverId,
              tempId,
              reason: senderBlockedReceiver
                ? "You blocked this user"
                : "You are blocked by this user",
            };
            io.to(String(senderId)).emit("message_blocked", blockedPayload);
            reply({ ok: false, blocked: true, ...blockedPayload });
            return;
          }
        }
      } catch (e) {
        console.error("block check failed", e?.message || e);
        reply({ ok: false, error: "Could not verify block status" });
        return;
      }

      if (!senderId || !receiverId) {
        reply({ ok: false, error: "senderId and receiverId are required", tempId });
        return;
      }

      try {
      // Idempotency: a retry / reconnect flush of the same optimistic message
      // (same tempId) must not create a second copy.
      if (tempId) {
        const existing = await Message.findOne({ senderId, tempId }).populate("parent");
        if (existing) {
          const existingMessage = serializeMessage(existing);
          reply({ ok: true, updatedMessage: existingMessage, tempId, duplicate: true });
          io.to(String(senderId)).emit("messageSent", {
            updatedMessage: existingMessage,
            chatPage: true,
            isRealTime: true,
            tempId,
          });
          return;
        }
      }

      const newMessage = new Message({
        room: chatRoom,
        senderId,
        receiverId: String(receiverId),
        message,
        attachment: attachment || undefined,
        // Clients send `parent: false` when not replying.
        ...(parent && isValidObjectId(parent) ? { parent } : {}),
        messageType,
        duration,
        callType,
        callEvent,
        tempId,
      });
      await newMessage.save();

      // Update last active time for sending message
      await updateLastActive(senderId);

      let updatedMessage = await Message.findOne({
        _id: newMessage._id,
      }).populate("parent");
      let profileData = await Profile.findById(senderId).populate("user");
      if (!profileData) {
        reply({ ok: false, error: "Sender profile not found" });
        return;
      }
      const senderName = senderDisplayName(profileData);
      let senderPP = profileData.profilePic || config?.defaultProfile;

      updatedMessage = serializeMessage(updatedMessage);
      updatedMessage.senderName = senderName;
      updatedMessage.senderPP = senderPP;

      const messagePayload = {
        updatedMessage,
        senderName,
        senderPP,
        chatPage: true,
        isRealTime: true,
        tempId,
      };

      io.to(chatRoom).emit("newMessage", messagePayload);
      // Sender confirmation on every device of the sender (web tab + phone),
      // even if they are not currently in the chat room.
      io.to(String(senderId)).emit("messageSent", messagePayload);
      reply({ ok: true, updatedMessage, tempId });

      const connectProfile = profileData;
      // Emit newMessageToUser only for real-time messages (isRealTime: true)
      // This ensures the receiver gets notification only when a NEW message arrives
      io.to(String(receiverId)).emit("newMessageToUser", {
        updatedMessage,
        senderName,
        senderPP,
        chatPage: false,
        connectProfile,
        isRealTime: true, // Flag indicates this is a real-time notification, not from initial load
      });

      // Push (mobile) + bell / Web Push (web). Runs after the ack so sending
      // never waits on notification delivery.
      await notifyNewChatMessage(io, {
        updatedMessage,
        senderId,
        receiverId,
        senderName,
        senderPP,
        senderProfile: profileData,
        room: chatRoom,
      });

      } catch (error) {
        console.error("sendMessage failed:", error?.message || error);
        reply({ ok: false, error: error?.message || "Failed to send message", tempId });
      }
  });

  // Unified handler to emit emotion change to one, many, or all connects
  async function handleEmotionChange(payload, ack) {
    const receivedAt = Date.now();
    const {
      profileId,
      emotion,
      connectId,
      connectIds,
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
    const targetDescription =
      connectId || connectIds || (broadcast ? "broadcast" : null);

    console.info("[realtime_detection_received]", {
      socketId: socket.id,
      senderProfileId: profileId,
      emotion,
      emotionText,
      expression,
      confidence,
      quality,
      targets: targetDescription,
      receivedAt: new Date(receivedAt).toISOString(),
    });

    try {
      if (!profileId || !emotion) {
        const error = "Missing required parameters for emotion_change";
        console.error(error, {
          profileId,
          emotion,
        });
        if (typeof ack === "function") ack({ ok: false, error });
        return;
      }

      // Resolve target recipients
      let targets = [];
      if (Array.isArray(connectIds) && connectIds.length > 0) {
        console.log("connectIds.map(String)", connectIds.map(String));
        targets = connectIds.map(String);
      } else if (connectId && connectId !== "all") {
        targets = [String(connectId)];
      } else {
        // broadcast to all connects
        const me = await Profile.findById(profileId).select("connects");
        if (me?.connects && me.connects.length > 0) {
          targets = me.connects.map((id) => String(id));
        }
      }

      if (!targets || targets.length === 0) {
        console.warn("[realtime_detection_no_targets]", {
          senderProfileId: String(profileId),
          emotion,
          processingMs: Date.now() - receivedAt,
        });
        if (typeof ack === "function") {
          ack({ ok: false, error: "No target connects resolved", recipients: 0 });
        }
        return;
      }

      // Build and broadcast from the socket payload first. Profile persistence
      // is intentionally completed after delivery so MongoDB latency cannot
      // delay the realtime receiver.
      const data = {
        profileId: String(profileId),
        emotion,
        emotionText: emotionText || emotion,
        emoji,
        confidence,
        quality,
        // Include expression data from payload (forward to clients)
        expression: expression || "none",
        expressionData: expressionData || {},
        detectedExpressions: detectedExpressions || [],
        emotionScores: emotionScores || {},
        timestamp: new Date(),
      };

      // Emit to each target room (connect profileId is used as room)
      const recipients = targets.map((toId) => {
        const room = io.sockets.adapter.rooms.get(toId);
        const roomSockets = room ? [...room] : [];
        const fallbackSockets = [...io.sockets.sockets.values()]
          .filter((candidate) => {
            const candidateProfile =
              candidate.handshake.query?.profile ||
              candidate.handshake.auth?.profile ||
              candidate.handshake.auth?.profileId;
            return String(candidateProfile || '') === String(toId);
          })
          .map((candidate) => candidate.id);
        const socketIds = [...new Set([...roomSockets, ...fallbackSockets])];
        return {
          profileId: toId,
          connectedSockets: socketIds.length,
          socketIds,
        };
      });

      targets.forEach((toId) => {
        try {
          const recipient = recipients.find(
            ({ profileId }) => String(profileId) === String(toId),
          );
          if (recipient?.socketIds?.length) {
            recipient.socketIds.forEach((socketId) => {
              io.to(socketId).emit("emotion_change", data);
            });
          } else {
            io.to(toId).emit("emotion_change", data);
          }
        } catch (e) {
          console.error(
            "Emit emotion_change failed for",
            toId,
            e?.message || e,
          );
        }
      });

      console.info("[realtime_detection_broadcast]", {
        senderProfileId: String(profileId),
        emotion: data.emotion,
        expression: data.expression,
        confidence: data.confidence,
        recipients,
        processingMs: Date.now() - receivedAt,
      });

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
        console.error("Failed to persist emotion profile:", profileId);
      } else {
        console.info("[realtime_detection_persisted]", {
          senderProfileId: String(updateProfile._id),
          emotion: updateProfile.lastEmotion,
          confidence: updateProfile.lastEmotionConfidence,
          processingMs: Date.now() - receivedAt,
        });
      }
      if (typeof ack === "function") {
        ack({
          ok: true,
          recipients: recipients.length,
          connectedRecipients: recipients.filter(
            ({ connectedSockets }) => connectedSockets > 0,
          ).length,
        });
      }
    } catch (error) {
      console.error("Error in emotion_change handler:", error);
      if (typeof ack === "function") {
        ack({ ok: false, error: error?.message || "Emotion broadcast failed" });
      }
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
        socket.to(room).emit("typing", {
          receiverId,
          senderId: profileId || senderId,
          isTyping: true,
          type,
        });
        // Update last active time for typing activity (only when actively typing)
        const activeProfileId = profileId || senderId;
        if (activeProfileId) {
          await updateLastActive(activeProfileId);
        }
      } else {
        socket.to(room).emit("typing", {
          receiverId,
          senderId: profileId || senderId,
          isTyping: false,
        });
      }
      // socket.to(room).emit('typing');
    },
  );

  socket.on("update_type", ({ room, type }) => {
    io.to(room).emit("update_type", { type });
  });

  socket.on("seenMessage", async (message) => {
    try {
      const messageId = message?._id;
      if (!messageId || !isValidObjectId(messageId)) return;
      // Only the receiver can mark a message as seen.
      const msg = await Message.findOneAndUpdate(
        { _id: messageId, receiverId: String(profileId) },
        { isSeen: true },
        { new: true },
      );
      if (!msg) return;
      // Deliver to both participants on every device, once per socket.
      io.to([msg.room, String(msg.senderId), String(msg.receiverId)].filter(Boolean))
        .emit("seenMessage", msg);
      await updateLastActive(profileId);
    } catch (error) {
      console.error("seenMessage failed:", error?.message || error);
    }
  });

  socket.on("last_emotion", async ({ connectId, profileId }) => {
    if (!isValidObjectId(connectId) && !isValidObjectId(profileId)) return;

    let profileData = await Profile.findOne({ _id: connectId }).select(
      "lastEmotion",
    );
    if (profileData) {
      io.to(profileId).emit("last_emotion", profileData);
    }
  });

  // Live voice relays (two-way Agora, auto-connect on the peer)
  socket.on("live-voice-start", async ({ to, channelName }) => {
    try {
      if (!to || !channelName) return;
      let callerName = "Connect";
      try {
        const myProfileData = await Profile.findById(profileId).select(
          "fullName",
        );
        callerName = myProfileData?.fullName || "Connect";
      } catch (_e) {}
      const payload = {
        from: String(profileId),
        channelName: String(channelName),
        callerName,
      };
      io.to(String(to)).emit("live-voice-start", payload);
      // Also notify the 1:1 chat room so a peer that is in the conversation
      // still auto-joins if they are not currently addressed by profile id.
      io.to(String(channelName)).emit("live-voice-start", payload);
    } catch (e) {
      console.error("live-voice-start relay failed:", e?.message || e);
    }
  });

  socket.on("live-voice-stop", ({ to, channelName }) => {
    try {
      if (!to && !channelName) return;
      const payload = {
        from: profileId,
        channelName: channelName || null,
      };
      if (to) {
        io.to(String(to)).emit("live-voice-stop", payload);
      }
      // Also notify anyone in the 1:1 chat room so the peer still
      // disconnects if they are not currently addressed by profile id.
      if (channelName) {
        io.to(String(channelName)).emit("live-voice-stop", payload);
      }
    } catch (e) {
      console.error("live-voice-stop relay failed:", e?.message || e);
    }
  });
};
