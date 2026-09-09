const router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const fitness = require("../controllers/fitnessController");
const multer = require("multer");

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, /^image\/(jpeg|png|webp|heic)$/i.test(file.mimetype));
  },
});

router.use(isAuth);
router.get("/profile", fitness.getProfile);
router.put("/profile", fitness.saveProfile);
router.post("/profile", fitness.saveProfile);
router.delete("/reset", fitness.resetFitness);
router.get("/dashboard", fitness.dashboard);
router.post("/coach", fitness.coach);
router.get("/recommendations", fitness.recommendations);
router.get("/meals", fitness.listMeals);
router.post("/meals/analyze", imageUpload.single("image"), fitness.analyzeMeal);
router.post("/analyze-food", imageUpload.single("image"), fitness.analyzeMeal);
router.post("/meals", fitness.createMeal);
router.get("/meals/:id", fitness.getMeal);
router.put("/meals/:id", fitness.updateMeal);
router.delete("/meals/:id", fitness.deleteMeal);
router.get("/weight", fitness.listWeights);
router.post("/weight", fitness.addWeight);
router.get("/progress", fitness.progress);
router.get("/reminders", fitness.listReminders);
router.post("/reminders", fitness.createReminder);
router.put("/reminders/:id", fitness.updateReminder);
router.delete("/reminders/:id", fitness.deleteReminder);

module.exports = router;
