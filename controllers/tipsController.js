const mongoose = require("mongoose");
const User = require("../models/User");
const Tip = require("../models/Tip");
const MonetizationSettings = require("../models/MonetizationSettings");

const getUserId = (req) => req.profile?.user?._id || req.profile?.user || req.profile?._id;

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

  const settings = await MonetizationSettings.findOne({ singletonKey: "default" }).lean();
  if (settings?.featureFlags?.tippingEnabled !== true) {
    return res.status(403).json({ message: "Creator tipping is currently unavailable" });
  }

  const recipient = await User.findOne({ username: recipientUsername }).select("_id").lean();
  if (!recipient) return res.status(404).json({ message: "Creator not found" });
  if (String(recipient._id) === String(senderId)) {
    return res.status(400).json({ message: "You cannot tip yourself" });
  }

  const feePercent = Number(settings?.tipping?.platformFeePercent ?? 20);
  const platformFeeCoins = Math.floor(amountCoins * feePercent / 100);
  const creatorAmountCoins = amountCoins - platformFeeCoins;
  if (creatorAmountCoins < 1) {
    return res.status(400).json({ message: "Tip amount is too small after platform fee" });
  }

  const session = await mongoose.startSession();
  try {
    let tip;
    await session.withTransaction(async () => {
      const debited = await User.findOneAndUpdate(
        { _id: senderId, walletBalanceCoins: { $gte: amountCoins } },
        { $inc: { walletBalanceCoins: -amountCoins } },
        { new: true, session },
      );
      if (!debited) {
        const error = new Error("Insufficient coin balance");
        error.statusCode = 400;
        throw error;
      }
      await User.updateOne(
        { _id: recipient._id },
        { $inc: { creatorEarningsCoins: creatorAmountCoins } },
        { session },
      );
      [tip] = await Tip.create([{
        senderId,
        creatorId: recipient._id,
        amountCoins,
        platformFeeCoins,
        creatorAmountCoins,
      }], { session });
    });
    return res.status(201).json({
      success: true,
      tip,
      message: `Tip sent. Creator received ${creatorAmountCoins} coins.`,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    return next(error);
  } finally {
    await session.endSession();
  }
};
