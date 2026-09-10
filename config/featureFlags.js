const FEATURE_FLAG_NAMES = [
  "subscriptionEnabled",
  "walletEnabled",
  "fitnessCoachingUpsellEnabled",
  "tippingEnabled",
  "affiliateLinksEnabled",
  "manualPaymentEnabled",
];

const DEFAULT_FEATURE_FLAGS = Object.freeze(
  FEATURE_FLAG_NAMES.reduce((flags, name) => {
    flags[name] = false;
    return flags;
  }, {}),
);

const parseBoolean = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
};

const getFeatureFlags = (env = process.env) =>
  FEATURE_FLAG_NAMES.reduce((flags, name) => {
    flags[name] = parseBoolean(env[`FEATURE_FLAG_${name}`], DEFAULT_FEATURE_FLAGS[name]);
    return flags;
  }, {});

module.exports = {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_NAMES,
  getFeatureFlags,
};
