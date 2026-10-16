const { prisma, isValidId } = require("../utils/db");
const { resetCursorSessionsForUser } = require("../utils/cursorAgentClient");

const getProfileId = (req) => req.profile?._id;

exports.saveAIChat = async (req, res) => {
  try {
    const profileId = getProfileId(req);
    const { messages, timestamp } = req.body;

    if (!profileId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (!Array.isArray(messages)) {
      return res.status(400).json({ message: "Messages must be an array" });
    }

    const sessionTimestamp = timestamp ? new Date(timestamp) : new Date();
    await prisma.aIChat.upsert({
      where: { user: String(profileId) },
      update: { messages, sessionTimestamp },
      create: { user: String(profileId), messages, sessionTimestamp },
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error saving AI chat:", error);
    return res.status(500).json({ message: "Failed to save AI chat" });
  }
};

exports.getAIChatHistory = async (req, res) => {
  try {
    const profileId = getProfileId(req);

    if (!profileId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const chats = await prisma.aIChat.findMany({
      where: { user: String(profileId) },
      orderBy: { updatedAt: "desc" },
    });
    return res.status(200).json(chats);
  } catch (error) {
    console.error("Error fetching AI chat history:", error);
    return res.status(500).json({ message: "Failed to fetch AI chat history" });
  }
};

exports.getLatestAIChat = async (req, res) => {
  try {
    const profileId = getProfileId(req);

    if (!profileId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const chat = await prisma.aIChat.findFirst({
      where: { user: String(profileId) },
      orderBy: { updatedAt: "desc" },
    });
    return res.status(200).json(chat || { messages: [] });
  } catch (error) {
    console.error("Error fetching latest AI chat:", error);
    return res.status(500).json({ message: "Failed to fetch latest AI chat" });
  }
};

exports.deleteAIChat = async (req, res) => {
  try {
    const profileId = getProfileId(req);
    const { chatId } = req.query;

    if (!profileId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (chatId && !isValidId(chatId)) {
      return res.status(400).json({ message: "Invalid chat ID" });
    }

    const where = { user: String(profileId) };
    if (chatId) where.id = String(chatId);

    const { count: deletedCount } = await prisma.aIChat.deleteMany({ where });
    const result = { deletedCount };

    if (chatId && result.deletedCount === 0) {
      return res.status(404).json({ message: "AI chat not found" });
    }

    await resetCursorSessionsForUser(profileId).catch(() => 0);

    return res.status(200).json({
      message: "AI chat deleted successfully",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting AI chat:", error);
    return res.status(500).json({ message: "Failed to delete AI chat" });
  }
};
