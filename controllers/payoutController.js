const { prisma, toId, isDuplicate } = require("../utils/db");

const getUserId = (req) => toId(req.profile?.user?._id || req.profile?.user || req.profile?._id);
const getSettings = async () => {
  const settings = await prisma.monetizationSettings.findUnique({ where: { singletonKey: "default" } });
  return {
    coinToBDTRate: Number(settings?.payout?.coinToBDTRate || 0.1),
    minimumCoins: Number(settings?.payout?.minimumCoins || 100),
    actionRewardCoins: Number(settings?.payout?.actionRewardCoins || 10),
  };
};

exports.listPayoutRequests = async (req, res, next) => {
  try {
    const requests = await prisma.payoutRequest.findMany({
      where: { userId: getUserId(req) },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ success: true, requests });
  } catch (error) {
    return next(error);
  }
};

exports.createPayoutRequest = async (req, res, next) => {
  const { method, payoutAddress, recipientName, phoneNumber } = req.body || {};
  const amountCoins = Number(req.body?.amountCoins);
  if (!["mobile_recharge", "bkash", "nagad"].includes(method)) {
    return res.status(400).json({ success: false, message: "Choose mobile recharge, bKash, or Nagad." });
  }
  if (!Number.isInteger(amountCoins) || amountCoins < 1 ||
      typeof payoutAddress !== "string" || !payoutAddress.trim() ||
      typeof recipientName !== "string" || !recipientName.trim() ||
      typeof phoneNumber !== "string" || !phoneNumber.trim()) {
    return res.status(400).json({ success: false, message: "Valid payout details and a whole coin amount are required." });
  }

  try {
    const settings = await getSettings();
    if (amountCoins < settings.minimumCoins) {
      return res.status(400).json({ success: false, message: `Minimum payout is ${settings.minimumCoins} coins.` });
    }
    const userId = getUserId(req);
    const pending = await prisma.payoutRequest.count({ where: { userId, status: "pending" } });
    if (pending >= 3) {
      return res.status(429).json({ success: false, message: "You can have at most 3 pending payout requests." });
    }
    // Atomic reservation: only succeeds while withdrawable earnings cover the amount.
    const reserved = await prisma.$executeRaw`
      UPDATE users
      SET payoutReservedCoins = payoutReservedCoins + ${amountCoins}, updatedAt = NOW(3)
      WHERE id = ${userId} AND creatorEarningsCoins - payoutReservedCoins >= ${amountCoins}`;
    if (!reserved) {
      return res.status(400).json({ success: false, message: "You do not have enough withdrawable earnings." });
    }

    try {
      const request = await prisma.payoutRequest.create({
        data: {
          userId,
          method,
          payoutAddress: payoutAddress.trim(),
          recipientName: recipientName.trim(),
          phoneNumber: phoneNumber.trim(),
          amountCoins,
          amountBDT: Number((amountCoins * settings.coinToBDTRate).toFixed(2)),
          exchangeRate: settings.coinToBDTRate,
          auditLog: [],
        },
      });
      return res.status(201).json({ success: true, request });
    } catch (error) {
      await prisma.user.updateMany({
        where: { id: userId },
        data: { payoutReservedCoins: { decrement: amountCoins } },
      });
      throw error;
    }
  } catch (error) {
    return next(error);
  }
};

exports.claimActionReward = async (req, res, next) => {
  const actionKey = typeof req.body?.actionKey === "string" ? req.body.actionKey.trim() : "";
  const referenceId = typeof req.body?.referenceId === "string" ? req.body.referenceId.trim() : "";
  if (!actionKey || !referenceId) {
    return res.status(400).json({ success: false, message: "actionKey and referenceId are required." });
  }
  try {
    const settings = await getSettings();
    const userId = getUserId(req);
    try {
      await prisma.coinReward.create({ data: { userId, actionKey, referenceId, coins: settings.actionRewardCoins } });
    } catch (error) {
      if (isDuplicate(error)) {
        return res.status(409).json({ success: false, message: "This action has already earned coins." });
      }
      throw error;
    }
    await prisma.user.updateMany({
      where: { id: userId },
      data: { creatorEarningsCoins: { increment: settings.actionRewardCoins } },
    });
    return res.json({ success: true, coinsAwarded: settings.actionRewardCoins });
  } catch (error) {
    return next(error);
  }
};
