const Router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const { getWallet, claimDailyReward } = require("../controllers/walletController");
const { listPayoutRequests, createPayoutRequest, claimActionReward } = require("../controllers/payoutController");

Router.get("/", isAuth, getWallet);
Router.post("/daily-reward", isAuth, claimDailyReward);
Router.get("/payout-requests", isAuth, listPayoutRequests);
Router.post("/payout-requests", isAuth, createPayoutRequest);
Router.post("/action-reward", isAuth, claimActionReward);

module.exports = Router;
