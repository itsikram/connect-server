const {
  loadAiSettings,
  updateAiSettings,
  toAdminPayload,
  getProviderKey,
  isProviderEnabled,
} = require("../utils/aiSettingsStore");
const {
  listCursorModels,
  completeCursorAgent,
} = require("../utils/cursorAgentClient");

const axios = require("axios");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const publicError = (error) => {
  const fromApi =
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message;
  return String(fromApi || "Request failed").slice(0, 400);
};

exports.getAdminAiSettings = async (req, res) => {
  try {
    const payload = await toAdminPayload();
    let cursorModels = [];
    try {
      cursorModels = await listCursorModels();
    } catch (_) {}
    return res.status(200).json({ ...payload, cursorModels });
  } catch (error) {
    return res.status(500).json({ message: publicError(error) });
  }
};

exports.updateAdminAiSettings = async (req, res) => {
  try {
    await updateAiSettings(req.body || {});
    const payload = await toAdminPayload();
    let cursorModels = [];
    try {
      cursorModels = await listCursorModels();
    } catch (_) {}
    return res.status(200).json({ ...payload, cursorModels });
  } catch (error) {
    return res.status(500).json({ message: publicError(error) });
  }
};

exports.listAdminCursorModels = async (req, res) => {
  try {
    const models = await listCursorModels();
    return res.status(200).json({ models });
  } catch (error) {
    return res.status(500).json({ message: publicError(error) });
  }
};

exports.testAdminAiProvider = async (req, res) => {
  try {
    const provider = String(req.body?.provider || "").toLowerCase();
    const typedKey = String(req.body?.apiKey || "").trim();
    const model = String(req.body?.model || "").trim();

    if (!["gemini", "openai", "cursor"].includes(provider)) {
      return res.status(400).json({ message: "Unknown provider" });
    }

    const enabled = await isProviderEnabled(provider);
    if (!enabled) {
      return res.status(400).json({
        message: `${provider} is disabled in AI settings`,
      });
    }

    const settings = await loadAiSettings();
    const apiKey = typedKey || (await getProviderKey(provider));
    if (!apiKey) {
      return res.status(400).json({
        message: `No API key configured for ${provider}. Paste a key and save, or test with a key in the field.`,
      });
    }

    const resolvedModel =
      model || settings.models?.[provider] || (provider === "cursor" ? "default" : "");

    if (provider === "cursor") {
      const text = await completeCursorAgent({
        model: resolvedModel,
        system: "Reply with the single word OK.",
        messages: [{ role: "user", content: "ping" }],
        json: false,
        userId: `admin-test-${req.admin?._id || "settings"}`,
      });
      return res.status(200).json({
        ok: true,
        provider,
        model: resolvedModel,
        reply: String(text || "").slice(0, 120),
      });
    }

    if (provider === "openai") {
      const response = await axios.post(
        OPENAI_URL,
        {
          model: resolvedModel || "gpt-4o-mini",
          messages: [
            { role: "system", content: "Reply with the single word OK." },
            { role: "user", content: "ping" },
          ],
          max_tokens: 16,
          temperature: 0,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 60000,
          validateStatus: () => true,
        },
      );
      if (response.status >= 400) {
        const message =
          response.data?.error?.message ||
          `OpenAI failed with HTTP ${response.status}`;
        return res.status(response.status).json({ message });
      }
      const text = String(
        response.data?.choices?.[0]?.message?.content || "",
      ).trim();
      return res.status(200).json({
        ok: true,
        provider,
        model: resolvedModel,
        reply: text.slice(0, 120),
      });
    }

    const geminiModel = resolvedModel || "gemini-2.0-flash";
    const keys = apiKey.split(",").map((item) => item.trim()).filter(Boolean);
    let lastError = "Gemini request failed";
    for (const key of keys) {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          geminiModel,
        )}:generateContent?key=${encodeURIComponent(key)}`,
        {
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          systemInstruction: { parts: [{ text: "Reply with the single word OK." }] },
          generationConfig: { temperature: 0, maxOutputTokens: 16 },
        },
        { timeout: 30000, validateStatus: () => true },
      );
      if (response.status < 400) {
        const text = (response.data?.candidates?.[0]?.content?.parts || [])
          .map((part) => part?.text || "")
          .join("")
          .trim();
        return res.status(200).json({
          ok: true,
          provider,
          model: geminiModel,
          reply: text.slice(0, 120),
        });
      }
      lastError =
        response.data?.error?.message ||
        `Gemini failed with HTTP ${response.status}`;
    }
    return res.status(400).json({ message: lastError });
  } catch (error) {
    const status = error.status || error.response?.status || 502;
    return res.status(status).json({ message: publicError(error) });
  }
};
