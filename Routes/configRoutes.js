const router = require("express").Router();
const { getPublicMonetizationConfig } = require("../controllers/monetizationSettingsController");

router.get("/flags", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  return getPublicMonetizationConfig(req, res, next);
});

module.exports = router;
