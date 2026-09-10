const User = require("../models/User");
const DAILY_REWARD_COINS = 10;

const todayKey = () => new Date().toISOString().slice(0, 10);

exports.getWallet = async (req, res, next) => {
  try {
    const userId = req.profile?.user?._id || req.profile?.user || req.profile?._id;
    const user = await User.findById(userId).select(
      "walletBalanceCoins creatorEarningsCoins payoutReservedCoins subscriptionStatus subscriptionTier subscriptionExpiresAt lastDailyCoinRewardDate",
    );

    if (!user) {
      return res.status(404).json({ message: "Wallet owner not found" });
    }

    const hasExpired = user.subscriptionStatus === "active" &&
      user.subscriptionExpiresAt &&
      user.subscriptionExpiresAt <= new Date();
    if (hasExpired) {
      await User.updateOne(
        { _id: user._id, subscriptionStatus: "active" },
        { $set: { subscriptionStatus: "expired", subscriptionTier: "none" } },
      );
    }

    const connectPlusActive = !hasExpired &&
      user.subscriptionStatus === "active" &&
      Boolean(user.subscriptionExpiresAt) &&
      user.subscriptionExpiresAt > new Date();

    return res.json({
      walletBalanceCoins: user.walletBalanceCoins || 0,
      creatorEarningsCoins: Math.max(
        0,
        (user.creatorEarningsCoins || 0) - (user.payoutReservedCoins || 0),
      ),
      payoutReservedCoins: user.payoutReservedCoins || 0,
      subscriptionStatus: hasExpired ? "expired" : user.subscriptionStatus || "none",
      subscriptionTier: hasExpired ? "none" : user.subscriptionTier || "none",
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
      connectPlusActive,
      dailyRewardCoins: DAILY_REWARD_COINS,
      dailyRewardAvailable: user.lastDailyCoinRewardDate !== todayKey(),
    });
  } catch (error) {
    return next(error);
  }
};

exports.claimDailyReward = async (req, res, next) => {
  try {
    const userId = req.profile?.user?._id || req.profile?.user || req.profile?._id;
    const rewardDate = todayKey();
    const result = await User.updateOne(
      {
        _id: userId,
        $or: [
          { lastDailyCoinRewardDate: { $exists: false } },
          { lastDailyCoinRewardDate: null },
          { lastDailyCoinRewardDate: { $ne: rewardDate } },
        ],
      },
      {
        $inc: { walletBalanceCoins: DAILY_REWARD_COINS },
        $set: { lastDailyCoinRewardDate: rewardDate },
      },
    );

    if (!result.modifiedCount) {
      return res.status(409).json({
        success: false,
        message: "Daily coin reward has already been claimed",
        dailyRewardAvailable: false,
      });
    }

    return res.json({
      success: true,
      coinsAwarded: DAILY_REWARD_COINS,
      dailyRewardAvailable: false,
    });
  } catch (error) {
    return next(error);
  }
};
