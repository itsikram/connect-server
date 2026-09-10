const router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const { sendTip } = require("../controllers/tipsController");

router.post("/send", isAuth, sendTip);

module.exports = router;
