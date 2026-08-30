const { Schema, model } = require("mongoose");

const PROVIDERS = ["gemini", "openai", "cursor"];

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
    },
    models: {
      gemini: { type: String, default: "gemini-3.5-flash" },
      openai: { type: String, default: "gpt-4o-mini" },
      cursor: { type: String, default: "default" },
    },
    keys: {
      gemini: { type: String, default: "" },
      openai: { type: String, default: "" },
      cursor: { type: String, default: "" },
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
