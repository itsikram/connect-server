const Transaction = require("../models/Transaction");
const User = require("../models/User");
const CoachingPurchase = require("../models/CoachingPurchase");

const PAYMENT_STATUSES = new Set(["pending", "approved", "rejected"]);
const SUBSCRIPTION_TIERS = new Set(["plus_basic", "plus_pro"]);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const adminId = (req) => String(req.admin?._id || "");
const reviewTimestamp = () => new Date();

const listPayments = async (req, res) => {
  const status = req.query.status || "pending";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (!PAYMENT_STATUSES.has(status)) {
    return res.status(400).json({
      success: false,
      message: "status must be pending, approved, or rejected",
    });
  }

  try {
    const query = { status };
    const safeSearch = escapeRegex(search);
    if (search) {
      query.$or = [
        { transactionId: { $regex: safeSearch, $options: "i" } },
        { senderMsisdn: { $regex: safeSearch, $options: "i" } },
      ];
    }
    const transactions = await Transaction.find(query)
      .sort({ submittedAt: -1 })
      .populate("userId", "firstName surname email")
      .lean();
    return res.json({ success: true, transactions });
  } catch (error) {
    console.error("Admin payment listing failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to list payments",
    });
  }
};

const approveSubscription = async (transaction) => {
  const user = await User.findById(transaction.userId);
  if (!user) {
    const error = new Error("Payment user not found");
    error.statusCode = 404;
    throw error;
  }

  const now = new Date();
  const currentExpiry =
    user.subscriptionExpiresAt instanceof Date &&
    user.subscriptionExpiresAt > now
      ? user.subscriptionExpiresAt
      : now;
  const tier = SUBSCRIPTION_TIERS.has(transaction.subscriptionTier)
    ? transaction.subscriptionTier
    : SUBSCRIPTION_TIERS.has(user.subscriptionTier)
      ? user.subscriptionTier
      : "plus_basic";

  await User.updateOne(
    { _id: transaction.userId },
    {
      $set: {
        subscriptionStatus: "active",
        subscriptionTier: tier,
        subscriptionExpiresAt: new Date(
          currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000,
        ),
      },
    },
  );
};

const approveWalletTopup = async (transaction) => {
  if (
    typeof transaction.coinsAmount !== "number" ||
    !Number.isFinite(transaction.coinsAmount) ||
    transaction.coinsAmount <= 0
  ) {
    const error = new Error("Approved wallet top-up is missing a valid coinsAmount");
    error.statusCode = 422;
    throw error;
  }

  await User.updateOne(
    { _id: transaction.userId },
    { $inc: { walletBalanceCoins: transaction.coinsAmount } },
  );
};

const approveCoachingPurchase = async (transaction) => {
  if (!transaction.coachingPlanId) {
    const error = new Error("Approved coaching payment is missing a coaching plan");
    error.statusCode = 422;
    throw error;
  }

  await CoachingPurchase.create({
    userId: transaction.userId,
    transactionId: transaction._id,
    planId: transaction.coachingPlanId,
    unlockedAt: reviewTimestamp(),
  });
};

const applyApprovalEffect = async (transaction) => {
  switch (transaction.type) {
    case "subscription":
      return approveSubscription(transaction);
    case "wallet_topup":
      return approveWalletTopup(transaction);
    case "coaching_purchase":
      return approveCoachingPurchase(transaction);
    default:
      return undefined;
  }
};

const approvePayment = async (req, res) => {
  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      status: "pending",
    });
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Pending payment not found",
      });
    }

    await applyApprovalEffect(transaction);

    const reviewedAt = reviewTimestamp();
    transaction.status = "approved";
    transaction.reviewedAt = reviewedAt;
    transaction.reviewedByAdminId = adminId(req);
    transaction.auditLog.push({
      action: "approved",
      adminId: adminId(req),
      timestamp: reviewedAt,
    });
    await transaction.save();

    return res.json({ success: true, transaction });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }
    console.error("Admin payment approval failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to approve payment",
    });
  }
};

const rejectPayment = async (req, res) => {
  const rejectionReason =
    typeof req.body?.rejectionReason === "string"
      ? req.body.rejectionReason.trim()
      : "";
  if (!rejectionReason) {
    return res.status(400).json({
      success: false,
      message: "rejectionReason is required",
    });
  }

  try {
    const transaction = await Transaction.findOne({
      _id: req.params.id,
      status: "pending",
    });
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Pending payment not found",
      });
    }

    const reviewedAt = reviewTimestamp();
    transaction.status = "rejected";
    transaction.reviewedAt = reviewedAt;
    transaction.reviewedByAdminId = adminId(req);
    transaction.rejectionReason = rejectionReason;
    transaction.auditLog.push({
      action: "rejected",
      adminId: adminId(req),
      timestamp: reviewedAt,
    });
    await transaction.save();

    return res.json({ success: true, transaction });
  } catch (error) {
    console.error("Admin payment rejection failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to reject payment",
    });
  }
};

module.exports = {
  listPayments,
  approvePayment,
  rejectPayment,
  applyApprovalEffect,
};
