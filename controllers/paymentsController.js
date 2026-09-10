const Transaction = require("../models/Transaction");

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

const getUserId = (req) => req.profile?.user?._id;

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

const createSubmitPaymentHandler = ({ TransactionModel = Transaction } = {}) =>
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
      if (error?.code === 11000) {
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
