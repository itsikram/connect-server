const Router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const { getWallet, claimDailyReward } = require("../controllers/walletController");
const { listPayoutRequests, createPayoutRequest } = require("../controllers/payoutController");

Router.get("/", isAuth, getWallet);
Router.post("/daily-reward", isAuth, claimDailyReward);
Router.get("/payout-requests", isAuth, listPayoutRequests);
Router.post("/payout-requests", isAuth, createPayoutRequest);
// POST /action-reward is switched off: it paid withdrawable coins for any
// actionKey/referenceId string a client sent, so a script could mint
// unlimited money. No web or app screen calls it. Grant action rewards on
// the server, at the moment it records the real action, instead.

module.exports = Router;
