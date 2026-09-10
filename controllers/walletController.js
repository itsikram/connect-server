const User = require("../models/User");

exports.getWallet = async (req, res, next) => {
  try {
    const userId = req.profile?.user?._id || req.profile?.user || req.profile?._id;
    const user = await User.findById(userId).select(
      "walletBalanceCoins subscriptionStatus subscriptionTier subscriptionExpiresAt",
    );

    if (!user) {
      return res.status(404).json({ message: "Wallet owner not found" });
    }

    return res.json({
      walletBalanceCoins: user.walletBalanceCoins || 0,
      subscriptionStatus: user.subscriptionStatus || "none",
      subscriptionTier: user.subscriptionTier || "none",
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
    });
  } catch (error) {
    return next(error);
  }
};
