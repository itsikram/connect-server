const PayoutRequest = require("../models/PayoutRequest");
const User = require("../models/User");

const statuses = new Set(["pending", "approved", "rejected"]);
const adminId = (req) => String(req.admin?._id || "");

exports.listPayouts = async (req, res, next) => {
  const status = req.query.status || "pending";
  if (!statuses.has(status)) return res.status(400).json({ success: false, message: "Invalid payout status." });
  try {
    const payouts = await PayoutRequest.find({ status }).sort({ createdAt: -1 })
      .populate("userId", "firstName surname email username creatorEarningsCoins payoutReservedCoins").lean();
    return res.json({ success: true, payouts });
  } catch (error) { return next(error); }
};

exports.approvePayout = async (req, res, next) => {
  try {
    const payout = await PayoutRequest.findOne({ _id: req.params.id, status: "pending" });
    if (!payout) return res.status(404).json({ success: false, message: "Pending payout not found." });
    const result = await User.updateOne(
      {
        _id: payout.userId,
        payoutReservedCoins: { $gte: payout.amountCoins },
        creatorEarningsCoins: { $gte: payout.amountCoins },
      },
      { $inc: { creatorEarningsCoins: -payout.amountCoins, payoutReservedCoins: -payout.amountCoins } },
    );
    if (!result.modifiedCount) return res.status(409).json({ success: false, message: "Reserved payout coins are unavailable." });
    const reviewedAt = new Date();
    payout.status = "approved";
    payout.reviewedAt = reviewedAt;
    payout.reviewedByAdminId = adminId(req);
    payout.auditLog.push({ action: "approved", adminId: adminId(req), timestamp: reviewedAt });
    await payout.save();
    return res.json({ success: true, payout });
  } catch (error) { return next(error); }
};

exports.rejectPayout = async (req, res, next) => {
  const reason = typeof req.body?.rejectionReason === "string" ? req.body.rejectionReason.trim() : "";
  if (!reason) return res.status(400).json({ success: false, message: "rejectionReason is required." });
  try {
    const payout = await PayoutRequest.findOne({ _id: req.params.id, status: "pending" });
    if (!payout) return res.status(404).json({ success: false, message: "Pending payout not found." });
    const restored = await User.updateOne(
      { _id: payout.userId, payoutReservedCoins: { $gte: payout.amountCoins } },
      { $inc: { payoutReservedCoins: -payout.amountCoins, creatorEarningsCoins: payout.amountCoins } },
    );
    if (!restored.modifiedCount) return res.status(409).json({ success: false, message: "Reserved payout coins are unavailable." });
    const reviewedAt = new Date();
    payout.status = "rejected";
    payout.rejectionReason = reason;
    payout.reviewedAt = reviewedAt;
    payout.reviewedByAdminId = adminId(req);
    payout.auditLog.push({ action: "rejected", adminId: adminId(req), timestamp: reviewedAt });
    await payout.save();
    return res.json({ success: true, payout });
  } catch (error) { return next(error); }
};
