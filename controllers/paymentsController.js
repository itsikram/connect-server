const { prisma, toId, isDuplicate } = require("../utils/db");
const { getPublicMonetizationConfig } = require("./monetizationSettingsController");

// Mongoose-like facade over prisma.transaction so the handler can still take
// an injectable model (see paymentsController.test.js).
const Transaction = {
  findOne: (where) => ({ lean: () => prisma.transaction.findFirst({ where }) }),
  countDocuments: (where) => prisma.transaction.count({ where }),
  create: (data) => prisma.transaction.create({ data: { auditLog: [], ...data } }),
};

const PAYMENT_METHODS = new Set(["bkash", "nagad"]);
const TRANSACTION_TYPES = new Set([
  "subscription",
  "wallet_topup",
  "tip_sent",
  "tip_received",
  "coaching_purchase",
  "affiliate_commission",
]);
const SUBSCRIPTION_TIERS = new Set(["plus_basic", "plus_pro"]);

const getUserId = (req) => toId(req.profile?.user?._id);

const validateSubmission = (body = {}) => {
  const paymentMethod =
    typeof body.paymentMethod === "string"
      ? body.paymentMethod.trim().toLowerCase()
      : "";
  const senderMsisdn =
    typeof body.senderMsisdn === "string" ? body.senderMsisdn.trim() : "";
  const transactionId =
    typeof body.transactionId === "string" ? body.transactionId.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const subscriptionTier =
    typeof body.subscriptionTier === "string"
      ? body.subscriptionTier.trim()
      : null;
  const coachingPlanId =
    typeof body.coachingPlanId === "string" ? body.coachingPlanId.trim() : null;
  const amountBDT = body.amountBDT;
  const coinsAmount = body.coinsAmount;
  const errors = {};

  if (!PAYMENT_METHODS.has(paymentMethod)) {
    errors.paymentMethod = "paymentMethod must be bkash or nagad";
  }
  if (
    !/^[0-9+() -]{7,20}$/.test(senderMsisdn) ||
    !/[0-9]/.test(senderMsisdn)
  ) {
    errors.senderMsisdn = "senderMsisdn must be a valid phone number";
  }
  if (type === "wallet_topup" && coinsAmount !== undefined &&
    (!Number.isInteger(coinsAmount) || coinsAmount <= 0)) {
    errors.coinsAmount = "coinsAmount must be a positive integer for wallet top-ups";
  }
  if (!transactionId || transactionId.length > 100) {
    errors.transactionId = "transactionId is required and must be 100 characters or fewer";
  }
  if (!TRANSACTION_TYPES.has(type)) {
    errors.type = "type is not a supported transaction type";
  }
  if (subscriptionTier && !SUBSCRIPTION_TIERS.has(subscriptionTier)) {
    errors.subscriptionTier = "subscriptionTier must be plus_basic or plus_pro";
  }
  if (coachingPlanId && coachingPlanId.length > 100) {
    errors.coachingPlanId = "coachingPlanId must be 100 characters or fewer";
  }
  if (
    typeof amountBDT !== "number" ||
    !Number.isFinite(amountBDT) ||
    amountBDT <= 0
  ) {
    errors.amountBDT = "amountBDT must be a positive number";
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    value: {
      paymentMethod,
      senderMsisdn,
      transactionId,
      type,
      amountBDT,
      coinsAmount: type === "wallet_topup" ? coinsAmount : null,
      subscriptionTier,
      coachingPlanId,
    },
  };
};

// The coin packs and plan prices the clients are offered, read through the
// public config handler so the check uses exactly that list (defaults included).
const loadPaymentConfig = () =>
  new Promise((resolve) => {
    getPublicMonetizationConfig({}, { json: resolve });
  });

// Approval credits the submitted coinsAmount / tier, so both must be an
// offer the client was shown at its price, not numbers the client picked.
const priceError = (value, config) => {
  if (value.type === "wallet_topup") {
    const pack = (config?.coinPacks || []).find((item) =>
      Number(item?.coins) === value.coinsAmount && Number(item?.priceBDT) === value.amountBDT);
    return pack ? null : "coinsAmount and amountBDT must match an available coin pack";
  }
  if (value.type === "subscription") {
    const plan = config?.subscriptionTiers?.[value.subscriptionTier];
    const ok = plan && plan.enabled !== false && Number(plan.priceBDT) === value.amountBDT;
    return ok ? null : "subscriptionTier and amountBDT must match an available plan";
  }
  return null;
};

const createSubmitPaymentHandler = ({ TransactionModel = Transaction, loadConfig = loadPaymentConfig } = {}) =>
  async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated user is required",
      });
    }

    const validation = validateSubmission(req.body);
    if (validation.errors) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment submission",
        errors: validation.errors,
      });
    }

    const { value } = validation;

    try {
      const duplicate = await TransactionModel.findOne({
        transactionId: value.transactionId,
        paymentMethod: value.paymentMethod,
      }).lean();
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: "This transaction ID has already been submitted for this payment method",
        });
      }

      const pendingCount = await TransactionModel.countDocuments({
        userId,
        status: "pending",
      });
      if (pendingCount >= 5) {
        return res.status(429).json({
          success: false,
          message: "You can have at most 5 pending payment submissions",
        });
      }

      const mismatch = priceError(value, await loadConfig());
      if (mismatch) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment submission",
          errors: { amountBDT: mismatch },
        });
      }

      const transaction = await TransactionModel.create({
        ...value,
        userId,
        status: "pending",
      });

      return res.status(201).json({
        success: true,
        message: "Payment submitted for review",
        transaction,
      });
    } catch (error) {
      if (isDuplicate(error) || error?.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "This transaction ID has already been submitted for this payment method",
        });
      }

      console.error("Payment submission failed:", error);
      return res.status(500).json({
        success: false,
        message: "Payment submission failed",
      });
    }
  };

module.exports = {
  createSubmitPaymentHandler,
  submitPayment: createSubmitPaymentHandler(),
  validateSubmission,
};
