const router = require("express").Router();
const { getFeatureFlags } = require("../config/featureFlags");

router.get("/flags", (_req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json(getFeatureFlags());
});

module.exports = router;
