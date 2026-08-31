const axios = require("axios");
const {
  completeCursorAgent,
  listCursorModels,
} = require("../utils/cursorAgentClient");
const {
  publicAiStatus,
  getProviderKey,
  isProviderEnabled,
} = require("../utils/aiSettingsStore");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const publicErrorMessage = (error) => {
  const fromApi =
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.response?.data?.error;
  const raw =
    typeof fromApi === "string"
      ? fromApi
      : error?.message || (fromApi ? JSON.stringify(fromApi) : "");
  return String(raw || "AI request failed").slice(0, 400);
};

const usesCompletionTokens = (model = "") =>
  /^(gpt-5|o[1-4]|gpt-4\.1)/i.test(String(model));

const toOpenAiMessages = (system, messages = []) => {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = String(msg.content || "");
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  return out;
};

const extractOpenAiText = (data) =>
  String(
    data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "",
  ).trim();

const completeOpenAi = async ({
  apiKey,
  model,
  system,
  messages,
  json,
  temperature,
  maxTokens,
}) => {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const body = {
    model,
    messages: toOpenAiMessages(system, messages),
    temperature,
  };

  if (json) {
    body.response_format = { type: "json_object" };
  }

  if (usesCompletionTokens(model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }

  const timeout = json ? 18000 : 28000;
  const response = await axios.post(OPENAI_URL, body, {
    headers,
    timeout,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const error = new Error(publicErrorMessage({ response }));
    error.status = response.status;
    throw error;
  }

  const text = extractOpenAiText(response.data);
  if (!text) {
    throw new Error("ChatGPT returned an empty reply");
  }
  return text;
};

const extractGeminiText = (data) =>
  (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("")
    .trim();

const parseGeminiKeys = (value = "") =>
  [
    ...new Set(
      String(value)
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ];

const isGeminiQuotaError = (status, data) => {
  const apiStatus = String(data?.error?.status || "").toUpperCase();
  const message = String(data?.error?.message || "").toLowerCase();
  return (
    status === 429 ||
    apiStatus === "RESOURCE_EXHAUSTED" ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("resource exhausted")
  );
};

const completeGemini = async ({
  apiKey,
  model,
  system,
  messages,
  json,
  temperature,
  maxTokens,
}) => {
  const keys = parseGeminiKeys(apiKey);
  if (!keys.length) {
    const error = new Error(
      "No Gemini API key is configured. Add it in Connect Admin → Settings → AI.",
    );
    error.status = 400;
    throw error;
  }

  const contents = [];
  let foundFirstUser = false;
  for (const msg of messages || []) {
    const role = msg.role === "assistant" ? "model" : "user";
    if (!foundFirstUser && role !== "user") continue;
    foundFirstUser = true;
    const text = String(msg.content || "");
    if (!text.trim()) continue;
    contents.push({ role, parts: [{ text }] });
  }

  const requestBody = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: {
      temperature,
      topK: json ? 8 : 16,
      topP: json ? 0.7 : 0.85,
      maxOutputTokens: json ? Math.min(maxTokens, 256) : Math.min(maxTokens, 320),
      candidateCount: 1,
      ...(json ? { responseMimeType: "application/json" } : {}),
      ...(/gemini-(2\.5|3)/i.test(String(model))
        ? { thinkingConfig: { thinkingBudget: 0 } }
        : {}),
    },
  };

  let lastError = null;
  for (let i = 0; i < keys.length; i += 1) {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model,
      )}:generateContent?key=${encodeURIComponent(keys[i])}`,
      requestBody,
      { timeout: json ? 18000 : 25000, validateStatus: () => true },
    );
    if (response.status < 400) {
      const text = extractGeminiText(response.data);
      if (!text) throw new Error("Gemini returned an empty reply");
      return text;
    }
    lastError = new Error(
      response.data?.error?.message ||
        `Gemini failed with HTTP ${response.status}`,
    );
    lastError.status = response.status;
    if (!isGeminiQuotaError(response.status, response.data)) {
      throw lastError;
    }
  }
  throw lastError || new Error("Gemini request failed");
};

exports.getAiProviders = async (req, res) => {
  const status = await publicAiStatus();
  let models = [];
  try {
    models = await listCursorModels();
  } catch (_) {
    models = [];
  }
  return res.status(200).json({
    defaultProvider: status.defaultProvider,
    enabled: status.enabled,
    models: status.models,
    configured: status.configured,
    gemini: { configured: status.configured.gemini },
    openai: { configured: status.configured.openai },
    cursor: {
      configured: status.configured.cursor,
      models,
    },
  });
};

exports.completeAiChat = async (req, res) => {
  try {
    const provider = String(req.body?.provider || "").toLowerCase();
    const model = String(req.body?.model || "").trim();
    const system = String(req.body?.system || "");
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const json = Boolean(req.body?.json);
    const temperature = Number.isFinite(Number(req.body?.temperature))
      ? Number(req.body.temperature)
      : 0.7;
    const maxTokens = Number(req.body?.maxTokens) || 1024;
    const userId = String(req.profile?._id || req.profile?.user?._id || "");

    if (!["gemini", "openai", "cursor"].includes(provider)) {
      return res.status(400).json({
        message: "Provider must be gemini, openai, or cursor",
      });
    }

    const enabled = await isProviderEnabled(provider);
    if (!enabled) {
      return res.status(400).json({
        message: `${provider} is disabled in Connect Admin AI settings`,
      });
    }

    if (provider === "cursor") {
      const text = await completeCursorAgent({
        model,
        system,
        messages,
        json,
        userId,
      });
      return res.status(200).json({
        text,
        provider,
        model: model || "default",
      });
    }

    const bodyKey =
      provider === "cursor" ? "" : String(req.body?.apiKey || "").trim();
    const apiKey = bodyKey || (await getProviderKey(provider));
    if (!apiKey) {
      return res.status(400).json({
        message: `No API key configured for ${provider}. Add it in Connect Admin → Settings → AI.`,
      });
    }
    if (!model) {
      return res.status(400).json({ message: "Model is required" });
    }

    const text =
      provider === "gemini"
        ? await completeGemini({
            apiKey,
            model,
            system,
            messages,
            json,
            temperature,
            maxTokens,
          })
        : await completeOpenAi({
            apiKey,
            model,
            system,
            messages,
            json,
            temperature,
            maxTokens,
          });

    return res.status(200).json({ text, provider, model });
  } catch (error) {
    const status = error.status || error.response?.status || 502;
    return res.status(status).json({
      message: publicErrorMessage(error),
    });
  }
};
