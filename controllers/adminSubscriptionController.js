const User = require("../models/User");

const SUBSCRIPTION_STATUSES = new Set(["none", "active", "expired", "cancelled"]);
const SUBSCRIPTION_TIERS = new Set(["plus_basic", "plus_pro"]);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const serializeUser = (user) => ({
  _id: user._id,
  firstName: user.firstName,
  surname: user.surname,
  email: user.email,
  username: user.username,
  createdAt: user.createdAt,
  lastLogin: user.lastLogin,
  subscriptionStatus: user.subscriptionStatus || "none",
  subscriptionTier: user.subscriptionTier || "none",
  subscriptionExpiresAt: user.subscriptionExpiresAt || null,
});

const listSubscriptions = async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "all";
  const tier = typeof req.query.tier === "string" ? req.query.tier : "all";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  if (status !== "all" && !SUBSCRIPTION_STATUSES.has(status)) {
    return res.status(400).json({ success: false, message: "Invalid subscription status" });
  }
  if (tier !== "all" && !SUBSCRIPTION_TIERS.has(tier)) {
    return res.status(400).json({ success: false, message: "Invalid subscription tier" });
  }

  try {
    const query = {};
    if (status !== "all") query.subscriptionStatus = status;
    if (tier !== "all") query.subscriptionTier = tier;
    if (search) {
      const safeSearch = escapeRegex(search);
      query.$or = [
        { email: { $regex: safeSearch, $options: "i" } },
        { firstName: { $regex: safeSearch, $options: "i" } },
        { surname: { $regex: safeSearch, $options: "i" } },
        { username: { $regex: safeSearch, $options: "i" } },
      ];
    }

    const users = await User.find(query)
      .select("firstName surname email username createdAt lastLogin subscriptionStatus subscriptionTier subscriptionExpiresAt")
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();

    return res.json({ success: true, users: users.map(serializeUser) });
  } catch (error) {
    console.error("Admin subscription listing failed:", error);
    return res.status(500).json({ success: false, message: "Unable to list subscriptions" });
  }
};

const grantSubscription = async (req, res) => {
  const { tier, durationDays } = req.body || {};
  const days = Number(durationDays);

  if (!SUBSCRIPTION_TIERS.has(tier)) {
    return res.status(400).json({ success: false, message: "tier must be plus_basic or plus_pro" });
  }
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    return res.status(400).json({ success: false, message: "durationDays must be an integer between 1 and 3650" });
  }

  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const now = new Date();
    const currentExpiry = user.subscriptionExpiresAt instanceof Date && user.subscriptionExpiresAt > now
      ? user.subscriptionExpiresAt
      : now;

    user.subscriptionStatus = "active";
    user.subscriptionTier = tier;
    user.subscriptionExpiresAt = new Date(currentExpiry.getTime() + days * 24 * 60 * 60 * 1000);
    await user.save();

    return res.json({
      success: true,
      message: "Complimentary subscription applied",
      user: serializeUser(user),
    });
  } catch (error) {
    console.error("Admin subscription grant failed:", error);
    return res.status(500).json({ success: false, message: "Unable to grant subscription" });
  }
};

const revokeSubscription = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { subscriptionStatus: "cancelled", subscriptionTier: "none", subscriptionExpiresAt: null } },
      { new: true },
    );
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    return res.json({ success: true, message: "Subscription access removed", user: serializeUser(user) });
  } catch (error) {
    console.error("Admin subscription revoke failed:", error);
    return res.status(500).json({ success: false, message: "Unable to revoke subscription" });
  }
};

module.exports = { listSubscriptions, grantSubscription, revokeSubscription };
