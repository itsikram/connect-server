const { prisma, toId } = require("../utils/db");

const getUserId = (req) => toId(req.profile?.user?._id || req.profile?.user || req.profile?._id);

exports.sendTip = async (req, res, next) => {
  const senderId = getUserId(req);
  const recipientUsername = typeof req.body?.recipientUsername === "string"
    ? req.body.recipientUsername.trim()
    : "";
  const amountCoins = req.body?.amountCoins;

  if (!recipientUsername || recipientUsername.length > 80) {
    return res.status(400).json({ message: "recipientUsername is required" });
  }
  if (!Number.isInteger(amountCoins) || amountCoins <= 0 || amountCoins > 100000) {
    return res.status(400).json({ message: "amountCoins must be an integer from 1 to 100000" });
  }

  try {
    const settings = await prisma.monetizationSettings.findUnique({ where: { singletonKey: "default" } });
    if (settings?.featureFlags?.tippingEnabled !== true) {
      return res.status(403).json({ message: "Creator tipping is currently unavailable" });
    }

    const recipient = await prisma.user.findFirst({ where: { username: recipientUsername }, select: { id: true } });
    if (!recipient) return res.status(404).json({ message: "Creator not found" });
    if (String(recipient.id) === String(senderId)) {
      return res.status(400).json({ message: "You cannot tip yourself" });
    }

    const feePercent = Number(settings?.tipping?.platformFeePercent ?? 20);
    const platformFeeCoins = Math.floor(amountCoins * feePercent / 100);
    const creatorAmountCoins = amountCoins - platformFeeCoins;
    if (creatorAmountCoins < 1) {
      return res.status(400).json({ message: "Tip amount is too small after platform fee" });
    }

    const tip = await prisma.$transaction(async (tx) => {
      const debited = await tx.user.updateMany({
        where: { id: senderId, walletBalanceCoins: { gte: amountCoins } },
        data: { walletBalanceCoins: { decrement: amountCoins } },
      });
      if (!debited.count) {
        const error = new Error("Insufficient coin balance");
        error.statusCode = 400;
        throw error;
      }
      await tx.user.updateMany({
        where: { id: recipient.id },
        data: { creatorEarningsCoins: { increment: creatorAmountCoins } },
      });
      return tx.tip.create({
        data: {
          senderId,
          creatorId: recipient.id,
          amountCoins,
          platformFeeCoins,
          creatorAmountCoins,
        },
      });
    });
    return res.status(201).json({
      success: true,
      tip,
      message: `Tip sent. Creator received ${creatorAmountCoins} coins.`,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    return next(error);
  }
};
