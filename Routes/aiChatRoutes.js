const router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const {
  saveAIChat,
  getAIChatHistory,
  getLatestAIChat,
  deleteAIChat,
} = require("../controllers/aiChatController");
const {
  completeAiChat,
  getAiProviders,
} = require("../controllers/aiCompleteController");

router.post("/save", isAuth, saveAIChat);
router.get("/history", isAuth, getAIChatHistory);
router.get("/latest", isAuth, getLatestAIChat);
router.delete("/delete", isAuth, deleteAIChat);
router.get("/providers", isAuth, getAiProviders);
router.post("/complete", isAuth, completeAiChat);

module.exports = router;
