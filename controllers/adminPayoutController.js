const { prisma, populated, jsonArray, isValidId } = require("../utils/db");

const statuses = new Set(["pending", "approved", "rejected"]);
const adminId = (req) => String(req.admin?._id || "");
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

exports.listPayouts = async (req, res, next) => {
  const status = req.query.status || "pending";
  if (!statuses.has(status)) return res.status(400).json({ success: false, message: "Invalid payout status." });
  try {
    const payouts = await prisma.payoutRequest.findMany({
      where: { status },
      orderBy: { createdAt: "desc" },
      include: {
        userIdDoc: {
          select: {
            id: true, firstName: true, surname: true, email: true, username: true,
            creatorEarningsCoins: true, payoutReservedCoins: true,
          },
        },
      },
    });
    return res.json({ success: true, payouts: populated(payouts, "userId") });
  } catch (error) { return next(error); }
};

// Moves a pending payout to `status` and adjusts the owner's coins in one transaction.
async function review(req, status, userWhere, userData, extra = {}) {
  if (!isValidId(req.params.id)) throw httpError(404, "Pending payout not found.");
  return prisma.$transaction(async (tx) => {
    const payout = await tx.payoutRequest.findFirst({ where: { id: req.params.id, status: "pending" } });
    if (!payout) throw httpError(404, "Pending payout not found.");
    const coins = await tx.user.updateMany({ where: userWhere(payout), data: userData(payout) });
    if (!coins.count) throw httpError(409, "Reserved payout coins are unavailable.");
    const reviewedAt = new Date();
    const claimed = await tx.payoutRequest.updateMany({
      where: { id: payout.id, status: "pending" },
      data: {
        status,
        ...extra,
        reviewedAt,
        reviewedByAdminId: adminId(req),
        auditLog: [...jsonArray(payout.auditLog), { action: status, adminId: adminId(req), timestamp: reviewedAt }],
      },
    });
    if (!claimed.count) throw httpError(404, "Pending payout not found.");
    return tx.payoutRequest.findUnique({ where: { id: payout.id } });
  });
}

const sendError = (res, next, error) =>
  error.statusCode ? res.status(error.statusCode).json({ success: false, message: error.message }) : next(error);

exports.approvePayout = async (req, res, next) => {
  try {
    const payout = await review(
      req,
      "approved",
      (p) => ({
        id: p.userId,
        payoutReservedCoins: { gte: p.amountCoins },
        creatorEarningsCoins: { gte: p.amountCoins },
      }),
      (p) => ({
        creatorEarningsCoins: { decrement: p.amountCoins },
        payoutReservedCoins: { decrement: p.amountCoins },
      }),
    );
    return res.json({ success: true, payout });
  } catch (error) { return sendError(res, next, error); }
};

exports.rejectPayout = async (req, res, next) => {
  const reason = typeof req.body?.rejectionReason === "string" ? req.body.rejectionReason.trim() : "";
  if (!reason) return res.status(400).json({ success: false, message: "rejectionReason is required." });
  try {
    const payout = await review(
      req,
      "rejected",
      (p) => ({ id: p.userId, payoutReservedCoins: { gte: p.amountCoins } }),
      (p) => ({
        payoutReservedCoins: { decrement: p.amountCoins },
        creatorEarningsCoins: { increment: p.amountCoins },
      }),
      { rejectionReason: reason },
    );
    return res.json({ success: true, payout });
  } catch (error) { return sendError(res, next, error); }
};
