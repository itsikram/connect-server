const { Schema, model } = require("mongoose");

// Singleton (singletonKey = "default"). Which live API/socket servers the web
// and Expo clients use; edited from the admin panel (Settings → Servers).
const serverSettingsSchema = new Schema(
  {
    singletonKey: { type: String, default: "default", unique: true },
    // "multi" (fail over across every enabled server) or "single"
    mode: { type: String, enum: ["multi", "single"], default: "multi" },
    servers: [
      {
        _id: false,
        url: { type: String, required: true },
        label: { type: String, default: "" },
        enabled: { type: Boolean, default: true },
      },
    ],
    singleServerUrl: { type: String, default: "" },
    // "random" spreads new clients over the servers; "priority" prefers the first healthy one
    strategy: { type: String, enum: ["random", "priority"], default: "random" },
    downCooldownSeconds: { type: Number, default: 60 },
  },
  { timestamps: true },
);

module.exports = model("ServerSettings", serverSettingsSchema);
