const Router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const { getWallet } = require("../controllers/walletController");

Router.get("/", isAuth, getWallet);

module.exports = Router;
