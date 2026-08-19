const fs = require("fs");
const path = require("path");

const LOG_FILE = path.resolve(__dirname, "../debug.log");
const ensureLogFile = () => {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, "", "utf8");
    }
  } catch (error) {
    console.error("[debugLogger] Unable to create log file:", error);
  }
};

ensureLogFile();

const safeStringify = (value) => {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
};

const writeLog = (level, message, meta = {}) => {
  const timestamp = new Date().toISOString();
  const detail = meta && Object.keys(meta).length ? ` ${safeStringify(meta)}` : "";
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${detail}`;

  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch (error) {
    console.error("[debugLogger] Failed to write log:", error);
  }
};

const LUDO_STATE_EVENT_ALLOWLIST = new Set([
  "players-snapshot",
  "roll-validated",
  "move-validated",
  "accept",
  "accepted-emitted",
  "players-get-response",
  "leave",
  "game-pruned",
]);

const debugLogger = {
  info: (message, meta) => writeLog("info", message, meta || {}),
  warn: (message, meta) => writeLog("warn", message, meta || {}),
  error: (message, meta) => writeLog("error", message, meta || {}),
  request: ({ method, url, statusCode, responseTimeMs, ip, userAgent, body }) => {
    writeLog("request", `${method} ${url}`, {
      statusCode,
      responseTimeMs,
      ip,
      userAgent,
      body,
    });
  },
  action: (action, payload) => writeLog("action", action, payload || {}),
  ludoState: (gameId, snapshot) => {
    const state = snapshot && typeof snapshot === "object" ? snapshot : { value: snapshot };
    writeLog("ludo-state", `game:${gameId || "unknown"}`, {
      gameId,
      snapshot: state,
    });
  },
  ludoEvent: (eventName, payload = {}) => {
    if (!LUDO_STATE_EVENT_ALLOWLIST.has(eventName)) {
      return;
    }
    writeLog("ludo-event", eventName, payload || {});
  },
};

module.exports = { debugLogger, LOG_FILE };
