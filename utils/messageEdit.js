// Editing a sent chat message. Shared by the HTTP route (POST /message/edit)
// and the socket event (`editMessage`) so both paths apply the same rules and
// notify clients the same way.
//
// Rules:
//   - only the sender can edit, and only plain text messages that have text
//     (call logs, voice notes and attachment-only messages are not editable);
//   - the new text is trimmed and can't be empty (delete the message instead);
//   - nobody can edit while either side has blocked the other, same as sending.
//
// Every device of both participants gets a `messageEdited` event:
//   { messageId, _id, room, senderId, receiverId, message, isEdited,
//     editedAt, updatedMessage }
const { isValidObjectId } = require("mongoose");
const Message = require("../models/Message");
const Profile = require("../models/Profile");
const { listHasId } = require("./ids");

const MAX_EDIT_LENGTH = 10000;
const PARENT_FIELDS = "message senderId attachment timestamp messageType";
// Same projection the chat history endpoints return to clients.
const CLIENT_FIELDS =
  "-unseenReminderEmailSentAt -unseenReminderEmailProcessingKey -unseenReminderEmailProcessingAt -unseenReminderEmailLastError";

class MessageEditError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "MessageEditError";
    this.status = status;
  }
}

const isEditableMessage = (message) => {
  if (!message) return false;
  if ((message.messageType || "text") !== "text") return false;
  return typeof message.message === "string" && message.message.trim().length > 0;
};

const loadClientMessage = async (messageId) => {
  try {
    return await Message.findById(messageId)
      .select(CLIENT_FIELDS)
      .populate({ path: "parent", select: PARENT_FIELDS })
      .lean();
  } catch (error) {
    // An old row whose `parent` isn't a valid id can't be populated; the
    // message itself is still fine to return.
    if (error?.name !== "CastError") throw error;
    return Message.findById(messageId).select(CLIENT_FIELDS).lean();
  }
};

const buildEditedPayload = (message) => ({
  messageId: String(message._id),
  _id: String(message._id),
  room: message.room,
  senderId: String(message.senderId),
  receiverId: String(message.receiverId),
  message: message.message,
  isEdited: true,
  editedAt: message.editedAt,
  updatedMessage: message,
});

async function editMessage({ io, profileId, messageId, text }) {
  const editorId = String(profileId || "");
  if (!editorId) throw new MessageEditError(401, "Authentication required");
  if (!messageId || !isValidObjectId(messageId)) {
    throw new MessageEditError(400, "A valid messageId is required");
  }
  if (typeof text !== "string") {
    throw new MessageEditError(400, "Message text is required");
  }
  const nextText = text.trim();
  if (!nextText) throw new MessageEditError(400, "Message can't be empty");
  if (nextText.length > MAX_EDIT_LENGTH) {
    throw new MessageEditError(
      400,
      `Message is too long (max ${MAX_EDIT_LENGTH} characters)`,
    );
  }

  const existing = await Message.findById(messageId)
    .select("senderId receiverId messageType message")
    .lean();
  if (!existing) throw new MessageEditError(404, "Message not found");
  // Sender ids are stored as strings, the authenticated id may be an ObjectId.
  if (String(existing.senderId) !== editorId) {
    throw new MessageEditError(403, "You can only edit your own messages");
  }
  if (!isEditableMessage(existing)) {
    throw new MessageEditError(400, "This message can't be edited");
  }

  if (existing.message === nextText) {
    return { message: await loadClientMessage(messageId), changed: false };
  }

  const receiverId = String(existing.receiverId || "");
  if (receiverId && receiverId !== editorId) {
    const [editorProfile, receiverProfile] = await Promise.all([
      Profile.findById(editorId).select("blockedUsers"),
      Profile.findById(receiverId).select("blockedUsers"),
    ]);
    if (
      listHasId(editorProfile?.blockedUsers, receiverId) ||
      listHasId(receiverProfile?.blockedUsers, editorId)
    ) {
      throw new MessageEditError(403, "You can't edit messages in this conversation");
    }
  }

  // Only these three fields are written: the rest of the (possibly older)
  // document is left exactly as it was.
  const result = await Message.updateOne(
    { _id: messageId, senderId: existing.senderId },
    { $set: { message: nextText, isEdited: true, editedAt: new Date() } },
  );
  if (!result || result.matchedCount === 0) {
    // Deleted between the read and the write.
    throw new MessageEditError(404, "Message not found");
  }

  const updatedMessage = await loadClientMessage(messageId);
  if (!updatedMessage) throw new MessageEditError(404, "Message not found");

  const payload = buildEditedPayload(updatedMessage);
  if (io) {
    // Room + both profile rooms: every device of both participants, once each,
    // whether or not the conversation is open.
    io.to(
      [
        updatedMessage.room,
        String(updatedMessage.senderId),
        String(updatedMessage.receiverId),
      ].filter(Boolean),
    ).emit("messageEdited", payload);
  }

  return { message: updatedMessage, changed: true, payload };
}

module.exports = {
  editMessage,
  isEditableMessage,
  MessageEditError,
  MAX_EDIT_LENGTH,
};
