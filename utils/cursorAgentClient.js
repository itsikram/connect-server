const axios = require("axios");
const fs = require("fs");
const path = require("path");

const CURSOR_API_BASE = "https://api.cursor.com/v1";
const POLL_MS = 2000;
const MAX_WAIT_MS = 180000;
const CREATE_TIMEOUT_MS = 120000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const MODELS_TTL_MS = 10 * 60 * 1000;
const agentSessions = new Map();
let modelsCache = { at: 0, items: null };

const CURSOR_LEGACY_MODELS = {
  auto: "default",
  "composer-2": "composer-2.5",
  "composer-2.0": "composer-2.5",
  "claude-4-sonnet-thinking": "claude-sonnet-4-5",
  "claude-4.5-sonnet": "claude-sonnet-4-5",
  "gpt-5": "gpt-5.4",
};

const FALLBACK_CURSOR_MODELS = [
  { id: "default", displayName: "Auto", aliases: ["auto"] },
  { id: "composer-2.5", displayName: "Composer 2.5", aliases: ["composer-latest", "composer"] },
  { id: "grok-4.6", displayName: "Cursor Grok 4.6", aliases: [] },
  { id: "grok-4.5", displayName: "Cursor Grok 4.5", aliases: [] },
  { id: "claude-opus-5", displayName: "Claude Opus 5", aliases: ["opus-latest", "opus"] },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", aliases: ["sonnet-latest", "sonnet-5"] },
  { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", aliases: ["sonnet-4.5"] },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", aliases: ["gpt-5.6"] },
  { id: "gpt-5.5", displayName: "GPT-5.5", aliases: [] },
  { id: "gpt-5.4", displayName: "GPT-5.4", aliases: ["gpt"] },
  { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro", aliases: ["gemini-pro"] },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", aliases: ["haiku"] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stringifyErrorData = (data) => {
  if (data == null) return "";
  if (typeof data === "string") return data;
  const nested =
    data.message ||
    data.error?.message ||
    data.error ||
    data.details ||
    data.code;
  if (typeof nested === "string") return nested;
  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
};

const publicCursorError = (error) => {
  const data = error?.response?.data;
  const raw =
    stringifyErrorData(data) ||
    error?.message ||
    "Cursor API request failed";
  return String(raw).slice(0, 400);
};

const timedOut = (error) =>
  error?.code === "ECONNABORTED" ||
  /timeout/i.test(String(error?.message || ""));

const toCursorError = (error, fallbackStatus = 502) => {
  if (error?.status && error.message) return error;
  if (timedOut(error)) {
    const next = new Error(
      "Cursor cloud agent timed out. The first run can take up to 2 minutes — try again.",
    );
    next.status = 504;
    return next;
  }
  const next = new Error(publicCursorError(error));
  next.status = error?.status || error?.response?.status || fallbackStatus;
  return next;
};

const cursorHeaders = (apiKey, authStyle = "basic") => {
  const headers = { "Content-Type": "application/json" };
  if (authStyle === "bearer") {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  }
  return headers;
};

const cursorRequest = async ({
  apiKey,
  method,
  url,
  data,
  timeout = 60000,
}) => {
  try {
    let response = await axios({
      method,
      url,
      data,
      headers: cursorHeaders(apiKey, "basic"),
      timeout,
      validateStatus: () => true,
    });

    if (response.status === 401 || response.status === 403) {
      response = await axios({
        method,
        url,
        data,
        headers: cursorHeaders(apiKey, "bearer"),
        timeout,
        validateStatus: () => true,
      });
    }

    return response;
  } catch (error) {
    throw toCursorError(error);
  }
};

const buildAgentPrompt = (system, messages = [], json = false) => {
  const lines = [
    "You are the in-app AI agent for Connect, a social web app.",
    "Do not write, edit, or search a code repository. Do not create files or pull requests.",
    "Answer the user's request directly.",
  ];
  if (json) {
    lines.push(
      "Return ONLY valid JSON. No markdown fences, no commentary before or after the JSON object.",
    );
  }
  if (system) {
    lines.push("", "Instructions:", system);
  }
  lines.push("", "Conversation:");
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = String(msg.content || "").trim();
    if (!content) continue;
    lines.push(`${role}: ${content}`);
  }
  return lines.join("\n").slice(0, 80000);
};

const extractRunText = (run = {}) => {
  const text = String(
    run.result || run.text || run.output || run.message || "",
  ).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return String(fenced?.[1] || text).trim();
};

const waitForRunResult = async ({ apiKey, agentId, runId }) => {
  const started = Date.now();
  let lastStatus = "CREATING";

  while (Date.now() - started < MAX_WAIT_MS) {
    const response = await cursorRequest({
      apiKey,
      method: "get",
      url: `${CURSOR_API_BASE}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      timeout: 30000,
    });

    if (response.status >= 400) {
      const error = new Error(publicCursorError({ response }));
      error.status = response.status;
      throw error;
    }

    const run = response.data?.run || response.data || {};
    lastStatus = String(run.status || "").toUpperCase();

    if (lastStatus === "FINISHED") {
      const text = extractRunText(run);
      if (!text) {
        throw new Error("Cursor agent finished without a text result");
      }
      return text;
    }

    if (["ERROR", "CANCELLED", "EXPIRED"].includes(lastStatus)) {
      throw new Error(
        stringifyErrorData(run) ||
          `Cursor agent run ended with status ${lastStatus}`,
      );
    }

    await sleep(POLL_MS);
  }

  const error = new Error(
    `Cursor agent timed out after ${Math.round(MAX_WAIT_MS / 1000)}s (last status: ${lastStatus}).`,
  );
  error.status = 504;
  throw error;
};

const archiveAgent = async (apiKey, agentId) => {
  try {
    await cursorRequest({
      apiKey,
      method: "post",
      url: `${CURSOR_API_BASE}/agents/${encodeURIComponent(agentId)}/archive`,
      data: {},
      timeout: 10000,
    });
  } catch (_) {}
};

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

const readCursorKeyFromEnvFile = () => {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    const text = fs.readFileSync(envPath, "utf8");
    let found = "";
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^CURSOR_API_KEY\s*=\s*(.*)$/);
      if (!match) continue;
      const value = stripEnvValue(match[1]);
      if (value) found = value;
    }
    return found;
  } catch (_) {
    return "";
  }
};

const getCursorApiKey = async () => {
  try {
    const { getProviderKey } = require("./aiSettingsStore");
    const fromAdmin = await getProviderKey("cursor");
    if (fromAdmin) return fromAdmin;
  } catch (_) {}
  return stripEnvValue(process.env.CURSOR_API_KEY) || readCursorKeyFromEnvFile();
};

exports.isCursorConfigured = async () => Boolean(await getCursorApiKey());

const parameterIds = (item = {}) =>
  (item.parameters || []).map((param) =>
    typeof param === "string" ? param : param?.id,
  ).filter(Boolean);

const toPublicModel = (item = {}) => ({
  id: item.id,
  label: item.displayName || item.id,
  aliases: Array.isArray(item.aliases) ? item.aliases : [],
});

const resolveCursorModel = (requested, items = []) => {
  const raw = String(requested || "default").trim();
  const mapped = CURSOR_LEGACY_MODELS[raw] || raw;
  if (!mapped || mapped === "auto" || mapped === "default") {
    return { omit: true, id: "default" };
  }

  const found =
    items.find((item) => item.id === mapped) ||
    items.find((item) => item.id === raw) ||
    items.find(
      (item) =>
        (item.aliases || []).includes(raw) ||
        (item.aliases || []).includes(mapped),
    );

  if (!found) {
    return { omit: true, id: "default" };
  }

  const params = [];
  if (
    parameterIds(found).includes("fast") &&
    /^(composer|grok)/i.test(found.id)
  ) {
    params.push({ id: "fast", value: "true" });
  }

  return { omit: false, id: found.id, params };
};

exports.isCursorConfigured = async () => Boolean(await getCursorApiKey());

exports.listCursorModels = async () => {
  if (modelsCache.items && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache.items.map(toPublicModel);
  }

  const apiKey = getCursorApiKey();
  if (!apiKey) {
    return FALLBACK_CURSOR_MODELS.map(toPublicModel);
  }

  try {
    const response = await cursorRequest({
      apiKey,
      method: "get",
      url: `${CURSOR_API_BASE}/models`,
      timeout: 20000,
    });
    const items = response.data?.items;
    if (response.status < 400 && Array.isArray(items) && items.length) {
      modelsCache = { at: Date.now(), items };
      return items.map(toPublicModel);
    }
  } catch (_) {}

  return (modelsCache.items || FALLBACK_CURSOR_MODELS).map(toPublicModel);
};

const loadModelCatalog = async (apiKey) => {
  if (modelsCache.items && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache.items;
  }
  try {
    const response = await cursorRequest({
      apiKey,
      method: "get",
      url: `${CURSOR_API_BASE}/models`,
      timeout: 20000,
    });
    const items = response.data?.items;
    if (response.status < 400 && Array.isArray(items) && items.length) {
      modelsCache = { at: Date.now(), items };
      return items;
    }
  } catch (_) {}
  return modelsCache.items || FALLBACK_CURSOR_MODELS;
};

const rememberSession = (userId, agentId, modelId) => {
  if (!userId || !agentId) return;
  agentSessions.set(userId, {
    agentId,
    modelId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
};

const takeExpiredSession = (userId) => {
  if (!userId) return null;
  const session = agentSessions.get(userId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    agentSessions.delete(userId);
    return null;
  }
  return session;
};

const followUpRun = async ({ apiKey, agentId, promptText, model }) => {
  const data = { prompt: { text: promptText } };
  if (model && !model.omit) {
    data.model = { id: model.id };
    if (model.params?.length) data.model.params = model.params;
  }
  return cursorRequest({
    apiKey,
    method: "post",
    url: `${CURSOR_API_BASE}/agents/${encodeURIComponent(agentId)}/runs`,
    data,
    timeout: 60000,
  });
};

const createAgent = async ({ apiKey, promptText, model }) => {
  const body = {
    prompt: { text: promptText },
    name: "Connect AI Agent",
  };
  if (model && !model.omit) {
    body.model = { id: model.id };
    if (model.params?.length) body.model.params = model.params;
  }
  const repoUrl = String(process.env.CURSOR_REPO_URL || "").trim();
  if (repoUrl) {
    body.repos = [{ url: repoUrl }];
  }

  let created = await cursorRequest({
    apiKey,
    method: "post",
    url: `${CURSOR_API_BASE}/agents`,
    data: body,
    timeout: CREATE_TIMEOUT_MS,
  });

  if (created.status >= 400 && body.model) {
    delete body.model;
    created = await cursorRequest({
      apiKey,
      method: "post",
      url: `${CURSOR_API_BASE}/agents`,
      data: body,
      timeout: CREATE_TIMEOUT_MS,
    });
  }

  return created;
};

exports.completeCursorAgent = async ({
  model,
  system,
  messages,
  json,
  userId,
} = {}) => {
  const apiKey = getCursorApiKey();
  if (!apiKey) {
    const error = new Error(
      "CURSOR_API_KEY is not set on the server. Add it to server/.env and restart Node.",
    );
    error.status = 400;
    throw error;
  }

  const catalog = await loadModelCatalog(apiKey);
  const resolvedModel = resolveCursorModel(model, catalog);
  const promptText = buildAgentPrompt(system, messages, json);
  const sessionKey = resolvedModel.id;
  const session = takeExpiredSession(userId);

  if (session && session.modelId === sessionKey) {
    const follow = await followUpRun({
      apiKey,
      agentId: session.agentId,
      promptText,
      model: resolvedModel,
    });
    if (follow.status < 400) {
      const runId =
        follow.data?.run?.id ||
        follow.data?.id ||
        follow.data?.agent?.latestRunId;
      if (runId) {
        rememberSession(userId, session.agentId, sessionKey);
        return waitForRunResult({
          apiKey,
          agentId: session.agentId,
          runId,
        });
      }
    }
    agentSessions.delete(userId);
    archiveAgent(apiKey, session.agentId);
  }

  const created = await createAgent({
    apiKey,
    promptText,
    model: resolvedModel,
  });

  if (created.status >= 400) {
    const error = new Error(publicCursorError({ response: created }));
    error.status = created.status;
    throw error;
  }

  const agentId = created.data?.agent?.id || created.data?.id;
  const runId =
    created.data?.run?.id ||
    created.data?.agent?.latestRunId ||
    created.data?.latestRunId;

  if (!agentId || !runId) {
    throw new Error("Cursor did not return an agent id and run id");
  }

  rememberSession(userId, agentId, sessionKey);
  return waitForRunResult({ apiKey, agentId, runId });
};
