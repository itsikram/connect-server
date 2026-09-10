const router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const { submitPayment } = require("../controllers/paymentsController");

router.post("/submit", isAuth, submitPayment);

module.exports = router;
