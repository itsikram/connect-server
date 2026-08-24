const router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const {
  saveAIChat,
  getAIChatHistory,
  getLatestAIChat,
  deleteAIChat,
} = require("../controllers/aiChatController");

router.post("/save", isAuth, saveAIChat);
router.get("/history", isAuth, getAIChatHistory);
router.get("/latest", isAuth, getLatestAIChat);
router.delete("/delete", isAuth, deleteAIChat);

module.exports = router;
