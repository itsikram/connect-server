const AIChat = require("../models/AIChat");

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

    const chat = await AIChat.findOneAndUpdate(
      { user: profileId },
      {
        $set: {
          messages,
          sessionTimestamp: timestamp || new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.status(200).json(chat);
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

    const chats = await AIChat.find({ user: profileId }).sort({ updatedAt: -1 });
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

    const chat = await AIChat.findOne({ user: profileId }).sort({ updatedAt: -1 });
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

    const filter = { user: profileId };
    if (chatId) filter._id = chatId;

    const result = chatId
      ? await AIChat.deleteOne(filter)
      : await AIChat.deleteMany(filter);

    if (chatId && result.deletedCount === 0) {
      return res.status(404).json({ message: "AI chat not found" });
    }

    return res.status(200).json({
      message: "AI chat deleted successfully",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid chat ID" });
    }

    console.error("Error deleting AI chat:", error);
    return res.status(500).json({ message: "Failed to delete AI chat" });
  }
};
