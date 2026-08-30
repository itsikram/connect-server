const Router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const { getDigest } = require("../controllers/contentController");

Router.get("/digest", isAuth, getDigest);

module.exports = Router;
