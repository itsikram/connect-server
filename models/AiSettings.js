const { Schema, model } = require("mongoose");

const PROVIDERS = ["gemini", "openai", "cursor", "grok", "groq"];

const aiSettingsSchema = new Schema(
  {
    singletonKey: {
      type: String,
      default: "default",
      unique: true,
    },
    defaultProvider: {
      type: String,
      enum: PROVIDERS,
      default: "gemini",
    },
    enabled: {
      gemini: { type: Boolean, default: true },
      openai: { type: Boolean, default: true },
      cursor: { type: Boolean, default: true },
      grok: { type: Boolean, default: true },
      groq: { type: Boolean, default: true },
    },
    models: {
      gemini: { type: String, default: "gemini-2.0-flash" },
      openai: { type: String, default: "gpt-4o-mini" },
      cursor: { type: String, default: "default" },
      grok: { type: String, default: "grok-3-mini" },
      groq: { type: String, default: "openai/gpt-oss-20b" },
    },
    keys: {
      gemini: { type: String, default: "" },
      openai: { type: String, default: "" },
      cursor: { type: String, default: "" },
      grok: { type: String, default: "" },
      groq: { type: String, default: "" },
    },
    cursorRepoUrl: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

module.exports = model("AiSettings", aiSettingsSchema);
module.exports.AI_SETTING_PROVIDERS = PROVIDERS;
