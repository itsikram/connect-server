const axios = require("axios");
const fs = require("fs");
const path = require("path");

const CURSOR_API_BASE = "https://api.cursor.com/v1";
const POLL_MS = 250;
const POLL_MAX_MS = 900;
const MAX_WAIT_MS = 180000;
const CREATE_TIMEOUT_MS = 120000;
const SESSION_TTL_MS = 45 * 60 * 1000;
const MAX_SESSION_TURNS = 12;
const MAX_PROMPT_CHARS = 10000;
const MAX_SYSTEM_CHARS = 3500;
const MAX_FOLLOWUP_CHARS = 5000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_CHARS = 400;
const MODELS_TTL_MS = 10 * 60 * 1000;
const FAST_CHAT_MODEL_IDS = [
  "composer-2.5",
  "composer-2",
  "grok-4.6",
];

const agentSessions = new Map();
const userLocks = new Map();
let modelsCache = { at: 0, items: null };
let modelsRefresh = null;

exports.clearCursorModelsCache = () => {
  modelsCache = { at: 0, items: null };
};

const CURSOR_LEGACY_MODELS = {
  auto: "default",
  "composer-2": "composer-2.5",
  "composer-2.0": "composer-2.5",
  "claude-4-sonnet-thinking": "claude-sonnet-4-5",
  "claude-4.5-sonnet": "claude-sonnet-4-5",
  "gpt-5": "gpt-5.4",
};

const FALLBACK_CURSOR_MODELS = [
  {
    id: "composer-2.5",
    displayName: "Composer 2.5 Fast",
    aliases: ["composer-latest", "composer", "default", "auto"],
    parameters: ["fast"],
  },
  { id: "default", displayName: "Auto (Composer 2.5 Fast)", aliases: ["auto"] },
  { id: "grok-4.6", displayName: "Cursor Grok 4.6", aliases: [], parameters: ["fast"] },
  { id: "grok-4.5", displayName: "Cursor Grok 4.5", aliases: [] },
  { id: "claude-opus-5", displayName: "Claude Opus 5", aliases: ["opus-latest", "opus"] },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", aliases: ["sonnet-latest", "sonnet-5"] },
  { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", aliases: ["sonnet-4.5"] },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", aliases: ["gpt-5.6"] },
  { id: "gpt-5.5", displayName: "GPT-5.5", aliases: [] },
  { id: "gpt-5.4", displayName: "GPT-5.4", aliases: ["gpt"] },
  { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro", aliases: ["gemini-pro"] },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    aliases: ["haiku"],
    parameters: ["fast"],
  },
];

const CHAT_GUARDRAILS =
  "Connect in-app assistant. No repo, no tools, no files. Reply in text now.";

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

const extractCompleteJson = (text = "") => {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = source.slice(start, i + 1);
        try {
          JSON.parse(slice);
          return slice;
        } catch {
          return "";
        }
      }
    }
  }
  return "";
};

const clipText = (value, max) => {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

const buildAgentPrompt = (system, messages = [], json = false, followUp = false) => {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const lines = [
    CHAT_GUARDRAILS,
    json
      ? "JSON only: {reply,actions,ask}. Use the conversation for names, pronouns, and what the user wants. No markdown."
      : "Use the conversation. Answer directly.",
  ];
  if (!followUp && system) {
    lines.push(clipText(system, MAX_SYSTEM_CHARS));
  } else if (followUp) {
    lines.push(
      json
        ? "Same JSON schema as before. Resolve him/her/that/it/yes from prior turns."
        : "Continue the same chat. Resolve him/her/that/it from prior turns.",
    );
  }
  if (recent.length) {
    lines.push("Conversation:");
    for (const msg of recent) {
      const role = msg.role === "assistant" ? "assistant" : "user";
      const content = clipText(msg.content, MAX_HISTORY_MESSAGE_CHARS);
      if (!content) continue;
      lines.push(`${role}: ${content}`);
    }
  }
  return lines.join("\n").slice(0, followUp ? MAX_FOLLOWUP_CHARS : MAX_PROMPT_CHARS);
};

const extractRunText = (run = {}) => {
  const text = String(
    run.result || run.text || run.output || run.message || "",
  ).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return String(fenced?.[1] || text).trim();
};

const parseSseBlock = (block = "") => {
  let event = "message";
  const dataLines = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const raw = dataLines.join("\n");
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { text: raw };
    }
  }
  return { event, data };
};

const readStreamToString = (stream) =>
  new Promise((resolve, reject) => {
    if (!stream || typeof stream.on !== "function") {
      resolve("");
      return;
    }
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });

const destroyStream = (stream) => {
  try {
    if (stream && typeof stream.destroy === "function") stream.destroy();
  } catch (_) {}
};

const cursorStreamGet = async (apiKey, url) => {
  const send = (authStyle) =>
    axios({
      method: "get",
      url,
      headers: {
        ...cursorHeaders(apiKey, authStyle),
        Accept: "text/event-stream",
      },
      responseType: "stream",
      timeout: MAX_WAIT_MS,
      validateStatus: () => true,
    });

  let response = await send("basic");
  if (response.status === 401 || response.status === 403) {
    destroyStream(response.data);
    response = await send("bearer");
  }
  return response;
};

const waitForRunViaPoll = async ({ apiKey, agentId, runId }) => {
  const started = Date.now();
  let lastStatus = "CREATING";
  let delay = POLL_MS;

  while (Date.now() - started < MAX_WAIT_MS) {
    const response = await cursorRequest({
      apiKey,
      method: "get",
      url: `${CURSOR_API_BASE}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      timeout: 15000,
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

    await sleep(delay);
    delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.35));
  }

  const error = new Error(
    `Cursor agent timed out after ${Math.round(MAX_WAIT_MS / 1000)}s (last status: ${lastStatus}).`,
  );
  error.status = 504;
  throw error;
};

const waitForRunViaStream = async ({
  apiKey,
  agentId,
  runId,
  json = false,
}) => {
  const url = `${CURSOR_API_BASE}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
  const response = await cursorStreamGet(apiKey, url);

  if (response.status === 404 || response.status === 410) {
    destroyStream(response.data);
    const error = new Error("stream unavailable");
    error.code = "STREAM_UNAVAILABLE";
    error.status = response.status;
    throw error;
  }

  if (response.status >= 400) {
    const body = await readStreamToString(response.data);
    const error = new Error(body.slice(0, 400) || `Cursor stream HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const stream = response.data;
  if (!stream || typeof stream.on !== "function") {
    const error = new Error("stream unavailable");
    error.code = "STREAM_UNAVAILABLE";
    throw error;
  }

  return new Promise((resolve, reject) => {
    let buffer = "";
    let assistant = "";
    let settled = false;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      destroyStream(stream);
      const out = String(text || "").trim();
      if (!out) {
        reject(new Error("Cursor agent finished without a text result"));
        return;
      }
      resolve(out);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      destroyStream(stream);
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(
        Object.assign(
          new Error(
            `Cursor agent timed out after ${Math.round(MAX_WAIT_MS / 1000)}s.`,
          ),
          { status: 504 },
        ),
      );
    }, MAX_WAIT_MS);

    const handleBlock = (block) => {
      if (!block.trim() || settled) return;
      const { event, data } = parseSseBlock(block);
      if (event === "assistant" && data?.text) {
        assistant += String(data.text);
        if (json) {
          const jsonText = extractCompleteJson(assistant);
          if (jsonText) {
            clearTimeout(timer);
            finish(jsonText);
          }
        }
      }
      if (event === "result") {
        clearTimeout(timer);
        const text = String(data?.text || "").trim() || assistant;
        if (["ERROR", "CANCELLED", "EXPIRED"].includes(String(data?.status || "").toUpperCase())) {
          fail(
            new Error(
              stringifyErrorData(data) ||
                `Cursor agent run ended with status ${data?.status}`,
            ),
          );
          return;
        }
        finish(text);
      }
      if (event === "error") {
        clearTimeout(timer);
        fail(new Error(data?.message || "Cursor stream error"));
      }
      if (event === "done" && assistant) {
        clearTimeout(timer);
        finish(assistant);
      }
    };

    stream.on("data", (chunk) => {
      buffer += Buffer.from(chunk).toString("utf8");
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      parts.forEach(handleBlock);
    });
    stream.on("end", () => {
      if (buffer) handleBlock(buffer);
      clearTimeout(timer);
      if (!settled) finish(assistant);
    });
    stream.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
};

const waitForRunResult = async (opts) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await waitForRunViaStream(opts);
    } catch (error) {
      const unavailable =
        error?.code === "STREAM_UNAVAILABLE" ||
        error?.status === 404 ||
        error?.status === 410;
      if (unavailable && attempt < 2) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      if (unavailable || error?.code === "ECONNRESET") {
        return waitForRunViaPoll(opts);
      }
      throw error;
    }
  }
  return waitForRunViaPoll(opts);
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
  (item.parameters || [])
    .map((param) => (typeof param === "string" ? param : param?.id))
    .filter(Boolean);

const toPublicModel = (item = {}) => ({
  id: item.id,
  label: item.displayName || item.id,
  aliases: Array.isArray(item.aliases) ? item.aliases : [],
});

const withFastParam = (found) => {
  const ids = parameterIds(found);
  const params =
    ids.includes("fast") || FAST_CHAT_MODEL_IDS.includes(found.id)
      ? [{ id: "fast", value: "true" }]
      : [];
  return { omit: false, id: found.id, params };
};

const pickFastChatModel = (items = []) => {
  for (const id of FAST_CHAT_MODEL_IDS) {
    const found = items.find((item) => item.id === id);
    if (found) return withFastParam(found);
  }
  return withFastParam({ id: "composer-2.5", parameters: ["fast"] });
};

const resolveCursorModel = (requested, items = []) => {
  const raw = String(requested || "default").trim();
  const mapped = CURSOR_LEGACY_MODELS[raw] || raw;
  if (!mapped || mapped === "auto" || mapped === "default") {
    return pickFastChatModel(items);
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
    if (FAST_CHAT_MODEL_IDS.includes(mapped) || FAST_CHAT_MODEL_IDS.includes(raw)) {
      return withFastParam({ id: mapped || raw, parameters: ["fast"] });
    }
    return pickFastChatModel(items);
  }

  return withFastParam(found);
};

const refreshModelsInBackground = (apiKey) => {
  if (!apiKey) return;
  if (modelsCache.items && Date.now() - modelsCache.at < MODELS_TTL_MS) return;
  if (modelsRefresh) return;
  modelsRefresh = (async () => {
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
      }
    } catch (_) {
    } finally {
      modelsRefresh = null;
    }
  })();
};

const catalogNow = (apiKey) => {
  refreshModelsInBackground(apiKey);
  return modelsCache.items || FALLBACK_CURSOR_MODELS;
};

exports.listCursorModels = async () => {
  const apiKey = await getCursorApiKey();
  if (apiKey) refreshModelsInBackground(apiKey);
  return (modelsCache.items || FALLBACK_CURSOR_MODELS).map(toPublicModel);
};

const sessionStoreKey = (userId, modelId) =>
  `${String(userId || "").trim()}::${String(modelId || "default")}`;

const rememberSession = (key, agentId, turns = 1) => {
  if (!key || !agentId) return;
  agentSessions.set(key, {
    agentId,
    turns,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
};

const getLiveSession = (key) => {
  if (!key) return null;
  const session = agentSessions.get(key);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    agentSessions.delete(key);
    return null;
  }
  return session;
};

const forgetSession = (key) => {
  if (key) agentSessions.delete(key);
};

const withUserLock = async (key, fn) => {
  const lockKey = key || `_anon_${Date.now()}`;
  const previous = userLocks.get(lockKey) || Promise.resolve();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => hold);
  userLocks.set(lockKey, chained);
  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    release();
    if (userLocks.get(lockKey) === chained) userLocks.delete(lockKey);
  }
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
    timeout: 30000,
  });
};

const createAgent = async ({ apiKey, promptText, model }) => {
  const body = {
    prompt: { text: promptText },
    name: "Connect AI Chat",
    autoCreatePR: false,
  };
  if (model && !model.omit) {
    body.model = { id: model.id };
    if (model.params?.length) body.model.params = model.params;
  }

  let created = await cursorRequest({
    apiKey,
    method: "post",
    url: `${CURSOR_API_BASE}/agents`,
    data: body,
    timeout: CREATE_TIMEOUT_MS,
  });

  if (created.status >= 400 && body.model?.params) {
    delete body.model.params;
    created = await cursorRequest({
      apiKey,
      method: "post",
      url: `${CURSOR_API_BASE}/agents`,
      data: body,
      timeout: CREATE_TIMEOUT_MS,
    });
  }

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

const runIdFrom = (payload = {}) =>
  payload.run?.id ||
  payload.id ||
  payload.agent?.latestRunId ||
  payload.latestRunId;

const agentIdFrom = (payload = {}) => payload.agent?.id || payload.id;

const waitCreatedRun = async ({ apiKey, created, json }) => {
  const payload = created.data || {};
  const agentId = agentIdFrom(payload);
  const runId = runIdFrom(payload);
  const run = payload.run || {};
  if (String(run.status || "").toUpperCase() === "FINISHED") {
    const text = extractRunText(run);
    if (text) return { agentId, text };
  }
  if (!agentId || !runId) {
    throw new Error("Cursor did not return an agent id and run id");
  }
  const text = await waitForRunResult({
    apiKey,
    agentId,
    runId,
    json,
  });
  return { agentId, text };
};

exports.completeCursorAgent = async ({
  model,
  system,
  messages,
  json,
  userId,
  apiKey: apiKeyOverride,
} = {}) => {
  const apiKey = String(apiKeyOverride || "").trim() || (await getCursorApiKey());
  if (!apiKey) {
    const error = new Error(
      "No Cursor API key is configured. Add it in Connect Admin → Settings → AI.",
    );
    error.status = 400;
    throw error;
  }

  const resolvedModel = resolveCursorModel(model, catalogNow(apiKey));
  const sessionKey = sessionStoreKey(userId, resolvedModel.id);

  return withUserLock(sessionKey, async () => {
    const live = getLiveSession(sessionKey);

    const liveTurns = Number(live?.turns) || 1;
    if (live && liveTurns < MAX_SESSION_TURNS) {
      const follow = await followUpRun({
        apiKey,
        agentId: live.agentId,
        promptText: buildAgentPrompt(system, messages, json, true),
        model: resolvedModel,
      });
      if (follow.status < 400) {
        const runId = runIdFrom(follow.data || {});
        if (runId) {
          rememberSession(sessionKey, live.agentId, liveTurns + 1);
          try {
            return await waitForRunResult({
              apiKey,
              agentId: live.agentId,
              runId,
              json,
            });
          } catch (_) {
            forgetSession(sessionKey);
            archiveAgent(apiKey, live.agentId);
          }
        }
      }
      forgetSession(sessionKey);
      archiveAgent(apiKey, live.agentId);
    } else if (live) {
      forgetSession(sessionKey);
      archiveAgent(apiKey, live.agentId);
    }

    const created = await createAgent({
      apiKey,
      promptText: buildAgentPrompt(system, messages, json, false),
      model: resolvedModel,
    });

    if (created.status >= 400) {
      const error = new Error(publicCursorError({ response: created }));
      error.status = created.status;
      throw error;
    }

    const { agentId, text } = await waitCreatedRun({
      apiKey,
      created,
      json,
    });
    rememberSession(sessionKey, agentId, 1);
    return text;
  });
};

exports.resetCursorSessionsForUser = async (userId) => {
  const uid = String(userId || "").trim();
  if (!uid) return 0;
  const prefix = `${uid}::`;
  const apiKey = await getCursorApiKey().catch(() => "");
  let count = 0;
  for (const [key, session] of [...agentSessions.entries()]) {
    if (key !== uid && !key.startsWith(prefix)) continue;
    agentSessions.delete(key);
    if (apiKey && session?.agentId) archiveAgent(apiKey, session.agentId);
    count += 1;
  }
  return count;
};
