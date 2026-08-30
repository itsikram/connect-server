const fs = require("fs");
const path = require("path");
const AiSettings = require("../models/AiSettings");

const CACHE_TTL_MS = 15000;
let cache = { at: 0, doc: null };

const PROVIDERS = ["gemini", "openai", "cursor"];

const defaultDoc = () => ({
  singletonKey: "default",
  defaultProvider: "gemini",
  enabled: { gemini: true, openai: true, cursor: true },
  models: {
    gemini: "gemini-3.5-flash",
    openai: "gpt-4o-mini",
    cursor: "default",
  },
  keys: { gemini: "", openai: "", cursor: "" },
  cursorRepoUrl: "",
});

const stripEnvValue = (value = "") => {
  let text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
};

const readEnvFileKey = (name) => {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    const text = fs.readFileSync(envPath, "utf8");
    let found = "";
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(new RegExp(`^${name}\\s*=\\s*(.*)$`));
      if (!match) continue;
      const value = stripEnvValue(match[1]);
      if (value) found = value;
    }
    return found;
  } catch (_) {
    return "";
  }
};

const envFallbackFor = (provider) => {
  if (provider === "cursor") {
    return (
      stripEnvValue(process.env.CURSOR_API_KEY) ||
      readEnvFileKey("CURSOR_API_KEY")
    );
  }
  if (provider === "openai") {
    return stripEnvValue(process.env.OPENAI_API_KEY);
  }
  return (
    stripEnvValue(process.env.GEMINI_API_KEY) ||
    stripEnvValue(process.env.REACT_APP_GEMINI_API_KEY)
  );
};

const normalizeDoc = (doc = {}) => {
  const base = defaultDoc();
  return {
    ...base,
    ...doc,
    enabled: { ...base.enabled, ...(doc.enabled || {}) },
    models: { ...base.models, ...(doc.models || {}) },
    keys: { ...base.keys, ...(doc.keys || {}) },
    defaultProvider: PROVIDERS.includes(doc.defaultProvider)
      ? doc.defaultProvider
      : "gemini",
    cursorRepoUrl: String(doc.cursorRepoUrl || "").trim(),
  };
};

exports.invalidateAiSettingsCache = () => {
  cache = { at: 0, doc: null };
};

exports.loadAiSettings = async ({ force = false } = {}) => {
  if (!force && cache.doc && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.doc;
  }
  let raw = await AiSettings.findOne({ singletonKey: "default" }).lean();
  if (!raw) {
    raw = (await AiSettings.create(defaultDoc())).toObject();
  }
  const doc = normalizeDoc(raw);
  cache = { at: Date.now(), doc };
  return doc;
};

exports.getProviderKey = async (provider) => {
  if (!PROVIDERS.includes(provider)) return "";
  const doc = await exports.loadAiSettings();
  const dbKey = stripEnvValue(doc.keys?.[provider]);
  return dbKey || envFallbackFor(provider);
};

exports.getCursorRepoUrl = async () => {
  const doc = await exports.loadAiSettings();
  return (
    String(doc.cursorRepoUrl || "").trim() ||
    stripEnvValue(process.env.CURSOR_REPO_URL)
  );
};

exports.isProviderEnabled = async (provider) => {
  const doc = await exports.loadAiSettings();
  return doc.enabled?.[provider] !== false;
};

exports.publicAiStatus = async () => {
  const doc = await exports.loadAiSettings();
  const configured = {};
  for (const provider of PROVIDERS) {
    configured[provider] = Boolean(await exports.getProviderKey(provider));
  }
  return {
    defaultProvider: doc.defaultProvider,
    enabled: doc.enabled,
    models: doc.models,
    configured,
  };
};

exports.toAdminPayload = async () => {
  const doc = await exports.loadAiSettings({ force: true });
  const configured = {};
  for (const provider of PROVIDERS) {
    configured[provider] = Boolean(stripEnvValue(doc.keys?.[provider]));
  }
  return {
    defaultProvider: doc.defaultProvider,
    enabled: doc.enabled,
    models: doc.models,
    cursorRepoUrl: doc.cursorRepoUrl,
    configured,
    updatedAt: doc.updatedAt || null,
  };
};

exports.updateAiSettings = async (patch = {}) => {
  const current = await exports.loadAiSettings({ force: true });
  const next = normalizeDoc(current);

  if (PROVIDERS.includes(patch.defaultProvider)) {
    next.defaultProvider = patch.defaultProvider;
  }
  if (patch.enabled && typeof patch.enabled === "object") {
    for (const provider of PROVIDERS) {
      if (typeof patch.enabled[provider] === "boolean") {
        next.enabled[provider] = patch.enabled[provider];
      }
    }
  }
  if (patch.models && typeof patch.models === "object") {
    for (const provider of PROVIDERS) {
      if (typeof patch.models[provider] === "string") {
        next.models[provider] = patch.models[provider].trim();
      }
    }
  }
  if (typeof patch.cursorRepoUrl === "string") {
    next.cursorRepoUrl = patch.cursorRepoUrl.trim();
  }
  if (patch.keys && typeof patch.keys === "object") {
    for (const provider of PROVIDERS) {
      if (typeof patch.keys[provider] !== "string") continue;
      const value = stripEnvValue(patch.keys[provider]);
      if (!value) continue;
      next.keys[provider] = value;
    }
  }
  if (Array.isArray(patch.clearKeys)) {
    for (const provider of patch.clearKeys) {
      if (PROVIDERS.includes(provider)) next.keys[provider] = "";
    }
  }

  const saved = await AiSettings.findOneAndUpdate(
    { singletonKey: "default" },
    {
      $set: {
        defaultProvider: next.defaultProvider,
        enabled: next.enabled,
        models: next.models,
        keys: next.keys,
        cursorRepoUrl: next.cursorRepoUrl,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();

  const doc = normalizeDoc(saved);
  cache = { at: Date.now(), doc };
  return doc;
};

exports.PROVIDERS = PROVIDERS;
