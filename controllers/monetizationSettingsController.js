const MonetizationSettings = require("../models/MonetizationSettings");
const {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_NAMES,
  getFeatureFlags,
} = require("../config/featureFlags");

const DEFAULT_COIN_PACKS = [
  { coins: 100, priceBDT: 99, enabled: true },
  { coins: 500, priceBDT: 449, enabled: true },
  { coins: 1000, priceBDT: 799, enabled: true },
];

const settingsDefaults = () => ({
  singletonKey: "default",
  featureFlags: { ...DEFAULT_FEATURE_FLAGS },
  paymentNumbers: { bkash: "", nagad: "" },
  subscriptionTiers: {
    plus_basic: { priceBDT: 49, durationDays: 30, enabled: true },
    plus_pro: { priceBDT: 149, durationDays: 30, enabled: true },
  },
  coinPacks: DEFAULT_COIN_PACKS,
  tipping: { platformFeePercent: 20 },
});

const serialize = (settings) => {
  const raw = settings?.toObject ? settings.toObject() : settings;
  const defaults = settingsDefaults();
  const rawFlags = raw?.featureFlags instanceof Map
    ? Object.fromEntries(raw.featureFlags.entries())
    : raw?.featureFlags || {};
  return {
    ...defaults,
    ...raw,
    featureFlags: { ...defaults.featureFlags, ...rawFlags },
    paymentNumbers: { ...defaults.paymentNumbers, ...(raw?.paymentNumbers || {}) },
    subscriptionTiers: { ...defaults.subscriptionTiers, ...(raw?.subscriptionTiers || {}) },
    coinPacks: raw?.coinPacks?.length ? raw.coinPacks : defaults.coinPacks,
    tipping: { ...defaults.tipping, ...(raw?.tipping || {}) },
  };
};

const getOrCreate = async () =>
  MonetizationSettings.findOneAndUpdate(
    { singletonKey: "default" },
    { $setOnInsert: settingsDefaults() },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

const validatePayload = (payload) => {
  const flags = payload.featureFlags;
  if (flags && (typeof flags !== "object" || Array.isArray(flags))) {
    return "featureFlags must be an object";
  }
  if (flags) {
    for (const [name, value] of Object.entries(flags)) {
      if (!FEATURE_FLAG_NAMES.includes(name) || typeof value !== "boolean") {
        return `${name} must be a known feature flag with a boolean value`;
      }
    }
  }
  if (payload.paymentNumbers) {
    for (const key of ["bkash", "nagad"]) {
      if (payload.paymentNumbers[key] !== undefined &&
        typeof payload.paymentNumbers[key] !== "string") {
        return `${key} payment number must be a string`;
      }
    }
  }
  for (const tier of ["plus_basic", "plus_pro"]) {
    const value = payload.subscriptionTiers?.[tier];
    if (!value) continue;
    if (!Number.isFinite(Number(value.priceBDT)) || Number(value.priceBDT) < 0 ||
      !Number.isInteger(Number(value.durationDays)) || Number(value.durationDays) < 1) {
      return `${tier} must have a valid priceBDT and durationDays`;
    }
  }
  if (payload.tipping?.platformFeePercent !== undefined &&
    (!Number.isFinite(Number(payload.tipping.platformFeePercent)) ||
      Number(payload.tipping.platformFeePercent) < 0 ||
      Number(payload.tipping.platformFeePercent) > 100)) {
    return "platformFeePercent must be between 0 and 100";
  }
  if (payload.coinPacks !== undefined) {
    if (!Array.isArray(payload.coinPacks)) return "coinPacks must be an array";
    for (const pack of payload.coinPacks) {
      if (!Number.isInteger(Number(pack.coins)) || Number(pack.coins) < 1 ||
        !Number.isFinite(Number(pack.priceBDT)) || Number(pack.priceBDT) < 0) {
        return "Each coin pack needs valid coins and priceBDT";
      }
    }
  }
  return null;
};

const getMonetizationSettings = async (_req, res, next) => {
  try {
    return res.json({ success: true, settings: serialize(await getOrCreate()) });
  } catch (error) {
    return next(error);
  }
};

const updateMonetizationSettings = async (req, res, next) => {
  const payload = req.body || {};
  const validationError = validatePayload(payload);
  if (validationError) return res.status(400).json({ success: false, message: validationError });

  try {
    const current = serialize(await getOrCreate());
    const nextSettings = serialize({
      ...current,
      ...payload,
      featureFlags: { ...current.featureFlags, ...(payload.featureFlags || {}) },
      paymentNumbers: { ...current.paymentNumbers, ...(payload.paymentNumbers || {}) },
      subscriptionTiers: { ...current.subscriptionTiers, ...(payload.subscriptionTiers || {}) },
      tipping: { ...current.tipping, ...(payload.tipping || {}) },
      updatedByAdminId: String(req.admin?._id || ""),
    });
    const settingsToSave = {
      singletonKey: "default",
      featureFlags: nextSettings.featureFlags,
      paymentNumbers: nextSettings.paymentNumbers,
      subscriptionTiers: nextSettings.subscriptionTiers,
      coinPacks: nextSettings.coinPacks,
      tipping: nextSettings.tipping,
      updatedByAdminId: nextSettings.updatedByAdminId,
    };
    const saved = await MonetizationSettings.findOneAndUpdate(
      { singletonKey: "default" },
      { $set: settingsToSave },
      { new: true, runValidators: true },
    );
    return res.json({ success: true, settings: serialize(saved) });
  } catch (error) {
    return next(error);
  }
};

const getPublicMonetizationConfig = async (_req, res) => {
  try {
    const settings = await MonetizationSettings.findOne({ singletonKey: "default" }).lean();
    const serialized = serialize(settings);
    return res.json({
      featureFlags: serialized.featureFlags,
      paymentNumbers: serialized.paymentNumbers,
      subscriptionTiers: serialized.subscriptionTiers,
      coinPacks: serialized.coinPacks.filter((pack) => pack.enabled),
      tipping: serialized.tipping,
    });
  } catch (error) {
    console.error("Unable to load monetization settings:", error);
    return res.json({
      featureFlags: getFeatureFlags(),
      paymentNumbers: { bkash: "", nagad: "" },
      subscriptionTiers: settingsDefaults().subscriptionTiers,
      coinPacks: DEFAULT_COIN_PACKS,
      tipping: settingsDefaults().tipping,
    });
  }
};

module.exports = {
  getMonetizationSettings,
  updateMonetizationSettings,
  getPublicMonetizationConfig,
};
