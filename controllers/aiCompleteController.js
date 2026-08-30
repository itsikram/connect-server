const axios = require("axios");
const {
  completeCursorAgent,
  isCursorConfigured,
  listCursorModels,
} = require("../utils/cursorAgentClient");

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

  const response = await axios.post(OPENAI_URL, body, {
    headers,
    timeout: 60000,
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

exports.getAiProviders = async (req, res) => {
  let models = [];
  try {
    models = await listCursorModels();
  } catch (_) {
    models = [];
  }
  return res.status(200).json({
    cursor: {
      configured: isCursorConfigured(),
      models,
    },
    openai: {
      configured: Boolean(String(process.env.OPENAI_API_KEY || "").trim()),
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

    if (!["openai", "cursor"].includes(provider)) {
      return res.status(400).json({
        message: "Provider must be openai or cursor for this endpoint",
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
        model: model || "auto",
      });
    }

    const apiKey = String(
      req.body?.apiKey || process.env.OPENAI_API_KEY || "",
    ).trim();
    if (!apiKey) {
      return res.status(400).json({ message: "OpenAI API key is required" });
    }
    if (!model) {
      return res.status(400).json({ message: "Model is required" });
    }

    const text = await completeOpenAi({
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
