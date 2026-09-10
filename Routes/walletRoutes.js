const Router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const { getWallet, claimDailyReward } = require("../controllers/walletController");

Router.get("/", isAuth, getWallet);
Router.post("/daily-reward", isAuth, claimDailyReward);

module.exports = Router;
