const router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const recovery = require("../controllers/recoveryController");

router.use(isAuth);
router.get("/content", recovery.getContent);
router.get("/resources", recovery.getResources);
router.get("/profile", recovery.getProfile);
router.put("/profile", recovery.saveProfile);
router.delete("/reset", recovery.reset);
router.get("/dashboard", recovery.dashboard);
router.get("/daily", recovery.daily);
router.post("/plan/generate", recovery.generatePlan);
router.put("/plan", recovery.updatePlan);
router.get("/checkins", recovery.listCheckins);
router.post("/checkins", recovery.saveCheckin);
router.get("/cravings", recovery.listCravings);
router.post("/cravings", recovery.logCraving);
router.get("/lapses", recovery.listLapses);
router.post("/lapses", recovery.logLapse);
router.post("/coach", recovery.coach);
router.get("/coach/history", recovery.coachHistory);
router.delete("/coach/history", recovery.clearCoachHistory);
router.get("/export", recovery.exportData);

module.exports = router;
