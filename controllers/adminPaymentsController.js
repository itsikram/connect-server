const { prisma, populated, jsonArray, isValidId } = require("../utils/db");

const PAYMENT_STATUSES = new Set(["pending", "approved", "rejected"]);
const SUBSCRIPTION_TIERS = new Set(["plus_basic", "plus_pro"]);

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
    const where = { status };
    if (search) {
      where.OR = [
        { transactionId: { contains: search } },
        { senderMsisdn: { contains: search } },
      ];
    }
    const transactions = await prisma.transaction.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      include: { userIdDoc: { select: { id: true, firstName: true, surname: true, email: true } } },
    });
    return res.json({ success: true, transactions: populated(transactions, "userId") });
  } catch (error) {
    console.error("Admin payment listing failed:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to list payments",
    });
  }
};

const approveSubscription = async (transaction, db = prisma) => {
  const user = await db.user.findUnique({ where: { id: String(transaction.userId) } });
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

  await db.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: "active",
      subscriptionTier: tier,
      subscriptionExpiresAt: new Date(
        currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000,
      ),
    },
  });
};

const approveWalletTopup = async (transaction, db = prisma) => {
  if (
    typeof transaction.coinsAmount !== "number" ||
    !Number.isFinite(transaction.coinsAmount) ||
    transaction.coinsAmount <= 0
  ) {
    const error = new Error("Approved wallet top-up is missing a valid coinsAmount");
    error.statusCode = 422;
    throw error;
  }

  await db.user.updateMany({
    where: { id: String(transaction.userId) },
    data: { walletBalanceCoins: { increment: transaction.coinsAmount } },
  });
};

const approveCoachingPurchase = async (transaction, db = prisma) => {
  if (!transaction.coachingPlanId) {
    const error = new Error("Approved coaching payment is missing a coaching plan");
    error.statusCode = 422;
    throw error;
  }

  await db.coachingPurchase.create({
    data: {
      userId: String(transaction.userId),
      transactionId: String(transaction.id ?? transaction._id),
      planId: transaction.coachingPlanId,
      unlockedAt: reviewTimestamp(),
    },
  });
};

// `db` may be a Prisma transaction client so the effect commits with the approval.
const applyApprovalEffect = async (transaction, db = prisma) => {
  switch (transaction.type) {
    case "subscription":
      return approveSubscription(transaction, db);
    case "wallet_topup":
      return approveWalletTopup(transaction, db);
    case "coaching_purchase":
      return approveCoachingPurchase(transaction, db);
    default:
      return undefined;
  }
};

// Atomically moves a pending payment to `status`; returns the updated row or null.
const reviewPending = async (db, id, status, req, extra = {}) => {
  if (!isValidId(id)) return null;
  const pending = await db.transaction.findFirst({ where: { id, status: "pending" } });
  if (!pending) return null;
  const reviewedAt = reviewTimestamp();
  const claimed = await db.transaction.updateMany({
    where: { id: pending.id, status: "pending" },
    data: {
      status,
      reviewedAt,
      reviewedByAdminId: adminId(req),
      ...extra,
      auditLog: [
        ...jsonArray(pending.auditLog),
        { action: status, adminId: adminId(req), timestamp: reviewedAt },
      ],
    },
  });
  return claimed.count ? pending : null;
};

const approvePayment = async (req, res) => {
  try {
    // Claim + effect in one DB transaction: no double approval, and a failed
    // effect leaves the payment pending.
    const transaction = await prisma.$transaction(async (tx) => {
      const pending = await reviewPending(tx, req.params.id, "approved", req);
      if (!pending) return null;
      await applyApprovalEffect(pending, tx);
      return tx.transaction.findUnique({ where: { id: pending.id } });
    });
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Pending payment not found",
      });
    }

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
    const pending = await reviewPending(prisma, req.params.id, "rejected", req, { rejectionReason });
    if (!pending) {
      return res.status(404).json({
        success: false,
        message: "Pending payment not found",
      });
    }
    const transaction = await prisma.transaction.findUnique({ where: { id: pending.id } });

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
