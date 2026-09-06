const axios = require("axios");
const {
  completeCursorAgent,
  listCursorModels,
  warmupCursorAgent,
} = require("../utils/cursorAgentClient");
const {
  publicAiStatus,
  getProviderKey,
  isProviderEnabled,
} = require("../utils/aiSettingsStore");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GROK_URL = "https://api.x.ai/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const parseProviderKeys = (value = "") =>
  [...new Set(String(value || "").split(/[,\r\n]+/).map(key => key.trim()).filter(Boolean))];
const isRateLimitError = (status, data, error) => {
  const message = String(data?.error?.message || data?.message || error?.message || "").toLowerCase();
  return status === 429 ||
    /rate limit|rate_limit|too many requests|quota|resource exhausted/.test(message);
};

const logAiResponse = ({ provider, model, response, text, toolCalls = [] }) => {
  if (process.env.NODE_ENV === "production") return;
  const choice = response?.choices?.[0];
  console.log("[AI] Response", {
    provider,
    model,
    finishReason: choice?.finish_reason || null,
    textLength: String(text || "").length,
    textPreview: String(text || "").slice(0, 500),
    toolCalls: toolCalls.map((call) => call?.function?.name || call?.name).filter(Boolean),
    usage: response?.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined,
  });
};

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

const openAiTextFromChoice = (choice) => {
  const content = choice?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  return "";
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

const toGroqSystem = (system = "") =>
  `${String(system)
    .replace(/Always return ONLY strict JSON with this shape:[\s\S]*?Use an empty actions array for questions and normal responses\.\s*/i, "")
    .trim()}\nUse the registered functions for app actions. Never call a function named "json"; return a concise JSON response only when no function is needed.`;

const toOpenAiRequestMessages = (system, messages, useTools) =>
  toOpenAiMessages(
    useTools ? toGroqSystem(system) : system,
    useTools ? messages.slice(-4) : messages,
  );

const extractOpenAiText = (data) =>
  String(
    data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "",
  ).trim();

const completeOpenAiWithKey = async ({
  apiKey,
  model,
  system,
  messages,
  json,
  temperature,
  maxTokens,
  endpoint = OPENAI_URL,
  providerLabel = "ChatGPT",
  useTools = false,
}) => {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const body = {
    model,
    messages: toOpenAiRequestMessages(system, messages, useTools),
    temperature,
  };

  if (json && !useTools) {
    body.response_format = { type: "json_object" };
  }
  if (useTools) {
    body.tools = OPENAI_AGENT_TOOLS;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }

  if (useTools) {
    // Groq's GPT-OSS models may spend completion tokens on hidden reasoning
    // before emitting a tool call; a small 220-token cap can end the stream
    // with neither content nor a callable action.
    body.max_completion_tokens = Math.max(maxTokens, 512);
  } else if (usesCompletionTokens(model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }

  const timeout = json ? 12000 : 20000;
  const response = await axios.post(endpoint, body, {
    headers,
    timeout,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const error = new Error(publicErrorMessage({ response }));
    if (providerLabel === "Groq" && process.env.NODE_ENV !== "production") {
      console.warn("[AI] Groq error", {
        status: response.status,
        error: response.data?.error || response.data?.message || null,
      });
    }
    error.status = response.status;
    throw error;
  }

  const choice = response.data?.choices?.[0];
  const text =
    (useTools && openAiToolCallIntent(choice?.message?.tool_calls)) ||
    openAiTextFromChoice(choice) ||
    extractOpenAiText(response.data);
  logAiResponse({
    provider: providerLabel,
    model,
    response: response.data,
    text,
    toolCalls: choice?.message?.tool_calls || [],
  });
  if (!text) {
    throw new Error(`${providerLabel} returned an empty reply`);
  }
  return text;
};

const completeOpenAi = async (options) => {
  const keys = parseProviderKeys(options.apiKey);
  let lastError;
  for (const apiKey of keys) {
    try {
      return await completeOpenAiWithKey({ ...options, apiKey });
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error.status || error.response?.status, error.response?.data, error) ||
          keys.indexOf(apiKey) === keys.length - 1) throw error;
    }
  }
  throw lastError || new Error("AI request failed");
};

const extractGeminiText = (data, { trim = true } = {}) => {
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("");
  return trim ? text.trim() : text;
};

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

const GEMINI_AGENT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "navigate",
        description: "Navigate to a registered Connect screen. Use exact routes: Home, Friends, Videos, Message, Menu, or Tasks. For messages use Message; for the current user's profile use navigate_profile.",
        parameters: {
          type: "OBJECT",
          properties: {
            route: { type: "STRING", description: "Registered screen route." },
          },
          required: ["route"],
        },
      },
      {
        name: "search_users",
        description: "Search Connect users by name. Never invent a user ID.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING" } },
          required: ["query"],
        },
      },
      {
        name: "view_profile",
        description: "Open a user's profile using a resolved ID or name.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
          },
        },
      },
      {
        name: "open_chat",
        description: "Open a conversation with a resolved user.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
          },
        },
      },
      {
        name: "send_message",
        description: "Send a message to a resolved Connect user. Understand English, Bangla, and Banglish recipient requests (for example, 'message Atik and say call me when available' or 'Atik ke message dao'). Put only the intended message body in messageText; translate it to the user's requested language when they explicitly ask. This is sensitive.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
            messageText: { type: "STRING" },
          },
          required: ["messageText"],
        },
      },
      {
        name: "start_audio_call",
        description: "Start an audio call with a resolved user. This is sensitive.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
          },
        },
      },
      {
        name: "start_video_call",
        description: "Start a video call with a resolved user. This is sensitive.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
          },
        },
      },
      {
        name: "follow_user",
        description: "Follow a resolved Connect user. This is sensitive.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
          },
        },
      },
      {
        name: "unfollow_user",
        description: "Unfollow a resolved Connect user. This is sensitive.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
          },
        },
      },
      {
        name: "block_user",
        description: "Block a resolved Connect user. This is sensitive.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
          },
        },
      },
      {
        name: "unblock_user",
        description: "Unblock a resolved Connect user. This is sensitive.",
        parameters: {
          type: "OBJECT",
          properties: {
            userId: { type: "STRING" },
            userName: { type: "STRING" },
          },
        },
      },
      {
        name: "search_video",
        description: "Search registered Connect watch videos by caption. Use this before play_video when the user names a video instead of providing an ID.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING" } },
          required: ["query"],
        },
      },
      {
        name: "play_video",
        description: "Play a selected registered video by its exact videoId returned by search_video.",
        parameters: {
          type: "OBJECT",
          properties: { videoId: { type: "STRING" } },
          required: ["videoId"],
        },
      },
      {
        name: "view_tasks",
        description: "Open the user's Tasks screen to view their tasks.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "create_task",
        description: "Create a task for the authenticated user.",
        parameters: {
          type: "OBJECT",
          properties: { text: { type: "STRING", description: "Task text." } },
          required: ["text"],
        },
      },
      {
        name: "update_task",
        description: "Edit or complete an existing task. Provide taskId when known, otherwise provide taskQuery matching the task text.",
        parameters: {
          type: "OBJECT",
          properties: {
            taskId: { type: "STRING" },
            taskQuery: { type: "STRING", description: "Unique text fragment identifying the task." },
            text: { type: "STRING" },
            completed: { type: "BOOLEAN" },
          },
        },
      },
      {
        name: "create_auto_reply_rule",
        description: "When the user explicitly asks you to remember an automatic reply rule, save it. On a future incoming message from that person, the app will send the specified reply. Understand English, Bangla, and Banglish instructions.",
        parameters: {
          type: "OBJECT",
          properties: {
            triggerUserName: { type: "STRING", description: "Friend whose incoming messages trigger the reply." },
            replyText: { type: "STRING", description: "Exact reply to send." },
          },
          required: ["triggerUserName", "replyText"],
        },
      },
    ],
  },
];

const functionCallIntent = (parts) => {
  const actions = (parts || [])
    .map((part) => part?.functionCall)
    .filter(Boolean)
    .map((call, index) => {
      const parameters =
        call.args && typeof call.args === "object" ? { ...call.args } : {};
      if (parameters.messageText && !parameters.message) {
        parameters.message = parameters.messageText;
      }
      return {
        id: `gemini-${index + 1}`,
        action: String(call.name || "").toUpperCase(),
        status: "pending",
        parameters,
      };
    });
  return actions.length
    ? JSON.stringify({
        type: "action",
        message: "ঠিক আছে, কাজটি করছি।",
        speak: true,
        requires_confirmation: false,
        actions,
      })
    : "";
};

const OPENAI_AGENT_TOOLS = GEMINI_AGENT_TOOLS[0].functionDeclarations.map(
  (declaration) => ({
    type: "function",
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(declaration.parameters?.properties || {}).map(
            ([name, value]) => [name, { ...value, type: String(value.type).toLowerCase() }],
          ),
        ),
        ...(declaration.parameters?.required
          ? { required: declaration.parameters.required }
          : {}),
      },
    },
  }),
);

const openAiToolCallIntent = (toolCalls = []) => {
  const actions = toolCalls.filter((call) => call?.function?.name).map((call, index) => {
    let parameters = {};
    try {
      const parsed = JSON.parse(call.function.arguments || "{}");
      if (parsed && typeof parsed === "object") parameters = parsed;
    } catch (_) {}
    if (parameters.messageText && !parameters.message) {
      parameters.message = parameters.messageText;
    }
    return {
      id: `groq-${index + 1}`,
      action: String(call.function.name).toUpperCase(),
      status: "pending",
      parameters,
    };
  });
  return actions.length
    ? JSON.stringify({
        type: "action",
        message: "Okay, I’m working on that.",
        speak: true,
        requires_confirmation: false,
        actions,
      })
    : "";
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
    tools: GEMINI_AGENT_TOOLS,
    generationConfig: {
      temperature,
      topK: json ? 4 : 12,
      topP: json ? 0.6 : 0.8,
      maxOutputTokens: json ? Math.min(maxTokens, 160) : Math.min(maxTokens, 220),
      candidateCount: 1,
      ...(!json ? {} : {}),
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
      { timeout: json ? 8000 : 16000, validateStatus: () => true },
    );
    if (response.status < 400) {
      const parts = response.data?.candidates?.[0]?.content?.parts || [];
      const text = functionCallIntent(parts) || extractGeminiText(response.data);
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
  if (status.configured?.cursor) {
    warmupCursorAgent().catch(() => {});
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
    grok: { configured: status.configured.grok },
    groq: { configured: status.configured.groq },
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

    if (!["gemini", "openai", "cursor", "grok", "groq"].includes(provider)) {
      return res.status(400).json({
        message: "Provider must be gemini, openai, cursor, grok, or groq",
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
            endpoint: provider === "grok" ? GROK_URL : provider === "groq" ? GROQ_URL : OPENAI_URL,
            providerLabel: provider === "grok" ? "Grok" : provider === "groq" ? "Groq" : "ChatGPT",
            useTools: provider === "groq",
          });

    return res.status(200).json({ text, provider, model });
  } catch (error) {
    const status = error.status || error.response?.status || 502;
    return res.status(status).json({
      message: publicErrorMessage(error),
    });
  }
};

const openSse = (res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
};

const writeSse = (res, payload) => {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === "function") res.flush();
};

const closeSse = (res, payload) => {
  writeSse(res, payload);
  if (!res.writableEnded) res.end();
};

const readAxiosSse = async (stream, onEvent) => {
  if (!stream) return;
  let buffer = "";
  const processPart = (part) => {
    const dataLines = [];
    for (const line of String(part).split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const raw = dataLines.join("\n");
    if (!raw || raw === "[DONE]") return;
    try {
      onEvent(JSON.parse(raw));
    } catch {
      onEvent({ text: raw });
    }
  };
  for await (const chunk of stream) {
    buffer += Buffer.from(chunk).toString("utf8");
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";
    parts.forEach(processPart);
  }
  if (buffer.trim()) processPart(buffer);
};

const streamOpenAiWithKey = async ({
  apiKey,
  model,
  system,
  messages,
  json,
  temperature,
  maxTokens,
  onDelta,
  signal,
  endpoint = OPENAI_URL,
  providerLabel = "ChatGPT",
  useTools = false,
}) => {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const body = {
    model,
    messages: toOpenAiRequestMessages(system, messages, useTools),
    temperature,
    stream: true,
  };
  if (json && !useTools) body.response_format = { type: "json_object" };
  if (useTools) {
    body.tools = OPENAI_AGENT_TOOLS;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  if (useTools) {
    body.max_completion_tokens = Math.max(maxTokens, 512);
  } else if (usesCompletionTokens(model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }

  const response = await axios.post(endpoint, body, {
    headers,
    timeout: json ? 12000 : 20000,
    responseType: "stream",
    validateStatus: () => true,
    signal,
  });

  if (response.status >= 400) {
    const raw = await new Promise((resolve) => {
      const chunks = [];
      response.data?.on?.("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.data?.on?.("end", () =>
        resolve(Buffer.concat(chunks).toString("utf8")),
      );
      response.data?.on?.("error", () => resolve(""));
      if (!response.data?.on) resolve("");
    });
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const error = new Error(publicErrorMessage({ response: { data: parsed, status: response.status } }));
    error.status = response.status;
    if (providerLabel === "Groq" && process.env.NODE_ENV !== "production") {
      console.warn("[AI] Groq stream error", {
        status: response.status,
        error: parsed?.error || parsed?.message || null,
      });
    }
    throw error;
  }

  let text = "";
  const toolCalls = new Map();
  let finalChoice = null;
  await readAxiosSse(response.data, (payload) => {
    finalChoice = payload?.choices?.[0] || finalChoice;
    const delta = finalChoice?.delta;
    const streamedToolCalls = delta?.tool_calls || (
      useTools && delta?.function_call
        ? [{ index: 0, function: delta.function_call }]
        : []
    );
    if (useTools && streamedToolCalls.length) {
      streamedToolCalls.forEach((call) => {
        const index = call.index || 0;
        const current = toolCalls.get(index) || {
          id: call.id,
          type: "function",
          function: { name: "", arguments: "" },
        };
        current.function.name += call.function?.name || "";
        current.function.arguments += call.function?.arguments || "";
        toolCalls.set(index, current);
      });
      return;
    }
    if (!delta?.content) return;
    const content = Array.isArray(delta.content)
      ? delta.content.map((part) => part?.text || "").join("")
      : String(delta.content);
    text += content;
    onDelta(text);
  });
  const toolIntent = useTools ? openAiToolCallIntent([...toolCalls.values()]) : "";
  if (toolIntent) {
    logAiResponse({
      provider: providerLabel,
      model,
      response: { choices: [finalChoice] },
      text: toolIntent,
      toolCalls: [...toolCalls.values()],
    });
    return toolIntent;
  }
  const finalText = openAiTextFromChoice(finalChoice);
  if (finalText) {
    logAiResponse({
      provider: providerLabel,
      model,
      response: { choices: [finalChoice] },
      text: finalText,
      toolCalls: [...toolCalls.values()],
    });
    onDelta(finalText);
    return finalText;
  }
  if (!text.trim()) {
    logAiResponse({
      provider: providerLabel,
      model,
      response: { choices: [finalChoice] },
      text,
      toolCalls: [...toolCalls.values()],
    });
    if (useTools) {
      // Some Groq models occasionally close an SSE response after emitting
      // only metadata. Retry once without streaming so the normal response
      // parser can recover a text reply or complete tool call.
      return completeOpenAi({
        apiKey,
        model,
        system,
        messages,
        json,
        temperature,
        maxTokens,
        endpoint,
        providerLabel,
        useTools: true,
      });
    }
    throw new Error(`${providerLabel} returned an empty reply`);
  }
  return text;
};

const streamOpenAi = async (options) => {
  const keys = parseProviderKeys(options.apiKey);
  let lastError;
  for (const apiKey of keys) {
    try {
      return await streamOpenAiWithKey({ ...options, apiKey });
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error.status || error.response?.status, error.response?.data, error) ||
          keys.indexOf(apiKey) === keys.length - 1) throw error;
    }
  }
  throw lastError || new Error("AI request failed");
};

const streamGeminiProvider = async ({
  apiKey,
  model,
  system,
  messages,
  json,
  temperature,
  maxTokens,
  onDelta,
  signal,
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
    tools: GEMINI_AGENT_TOOLS,
    generationConfig: {
      temperature,
      topK: json ? 4 : 12,
      topP: json ? 0.6 : 0.8,
      maxOutputTokens: json ? Math.min(maxTokens, 160) : Math.min(maxTokens, 220),
      candidateCount: 1,
      ...(json ? { responseMimeType: "application/json" } : {}),
      ...(/gemini-(2\.5|3)/i.test(String(model))
        ? { thinkingConfig: { thinkingBudget: 0 } }
        : {}),
    },
  };

  let lastError = null;
  for (let i = 0; i < keys.length; i += 1) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(keys[i])}`;
    const response = await axios.post(url, requestBody, {
      timeout: json ? 8000 : 16000,
      responseType: "stream",
      validateStatus: () => true,
      signal,
    });
    if (response.status >= 400) {
      const raw = await new Promise((resolve) => {
        const chunks = [];
        response.data?.on?.("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.data?.on?.("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
        response.data?.on?.("error", () => resolve(""));
        if (!response.data?.on) resolve("");
      });
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      lastError = new Error(
        parsed?.error?.message || `Gemini failed with HTTP ${response.status}`,
      );
      lastError.status = response.status;
      if (!isGeminiQuotaError(response.status, parsed)) {
        throw lastError;
      }
      continue;
    }

    let text = "";
    const functionCalls = [];
    await readAxiosSse(response.data, (payload) => {
      if (payload?.error?.message) {
        lastError = new Error(payload.error.message);
        return;
      }
      const parts = payload?.candidates?.[0]?.content?.parts || [];
      parts.forEach((part) => {
        if (part?.functionCall) functionCalls.push(part);
      });
      const chunk = extractGeminiText(payload, { trim: false });
      if (!chunk) return;
      text += chunk;
      onDelta(text);
    });
    const calledIntent = functionCallIntent(functionCalls);
    if (calledIntent) return calledIntent;
    if (!text.trim()) {
      throw lastError || new Error("Gemini returned an empty reply");
    }
    return text;
  }
  throw lastError || new Error("Gemini request failed");
};

exports.streamAiChat = async (req, res) => {
  const abort = new AbortController();
  const onClose = () => abort.abort();
  req.on("close", onClose);

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

    if (!["gemini", "openai", "cursor", "grok", "groq"].includes(provider)) {
      return res.status(400).json({
        message: "Provider must be gemini, openai, cursor, grok, or groq",
      });
    }

    const enabled = await isProviderEnabled(provider);
    if (!enabled) {
      return res.status(400).json({
        message: `${provider} is disabled in Connect Admin AI settings`,
      });
    }

    let text = "";
    const onDelta = (next) => {
      text = String(next || "");
      writeSse(res, { text });
    };

    if (provider === "cursor") {
      openSse(res);
      text = await completeCursorAgent({
        model,
        system,
        messages,
        json,
        userId,
        onDelta,
      });
      closeSse(res, { text, done: true, provider, model: model || "default" });
      return;
    }

    const bodyKey = String(req.body?.apiKey || "").trim();
    const apiKey = bodyKey || (await getProviderKey(provider));
    if (!apiKey) {
      return res.status(400).json({
        message: `No API key configured for ${provider}. Add it in Connect Admin → Settings → AI.`,
      });
    }
    if (!model) {
      return res.status(400).json({ message: "Model is required" });
    }

    openSse(res);
    text =
      provider === "gemini"
        ? await streamGeminiProvider({
            apiKey,
            model,
            system,
            messages,
            json,
            temperature,
            maxTokens,
            onDelta,
            signal: abort.signal,
          })
        : await streamOpenAi({
            apiKey,
            model,
            system,
            messages,
            json,
            temperature,
            maxTokens,
            onDelta,
            signal: abort.signal,
            endpoint: provider === "grok" ? GROK_URL : provider === "groq" ? GROQ_URL : OPENAI_URL,
            providerLabel: provider === "grok" ? "Grok" : provider === "groq" ? "Groq" : "ChatGPT",
           useTools: provider === "groq",
          });

    closeSse(res, { text, done: true, provider, model });
  } catch (error) {
    const message = publicErrorMessage(error);
    if (!res.headersSent) {
      const status = error.status || error.response?.status || 502;
      return res.status(status).json({ message });
    }
    closeSse(res, { error: message, done: true });
  } finally {
    req.off("close", onClose);
  }
};

exports.warmupAiChat = async (req, res) => {
  try {
    const model = String(req.body?.model || "").trim();
    const result = await warmupCursorAgent({ model });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(200).json({ started: false });
  }
};
