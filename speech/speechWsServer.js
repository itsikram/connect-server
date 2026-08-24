const jwt = require("jsonwebtoken");
const { spawn } = require("child_process");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const { WebSocketServer } = require("ws");

const JWT_SECRET = process.env.JWT_SECRET_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEFAULT_DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const DEFAULT_BANGLA_MODEL = process.env.DEEPGRAM_BANGLA_MODEL || "nova-3";
const FINALIZE_GRACE_MS = Number(process.env.SPEECH_FINALIZE_GRACE_MS || 1200);

const normalizeText = (text = "") => String(text).replace(/\s+/g, " ").trim();

const TIBETAN_CHAR_REGEX = /[\u0F00-\u0FFF]/;
const KANNADA_CHAR_REGEX = /[\u0C80-\u0CFF]/;
const BENGALI_CHAR_REGEX = /[\u0980-\u09FF]/;
const ALLOWED_TRANSCRIPT_CHAR_REGEX =
  /[\u0980-\u09FFa-zA-Z0-9\s.,!?;:'"()\-_/&@#+]/g;

const DG_EVENTS = {
  Open: LiveTranscriptionEvents?.Open || "open",
  Close: LiveTranscriptionEvents?.Close || "close",
  Error: LiveTranscriptionEvents?.Error || "error",
  Transcript: LiveTranscriptionEvents?.Transcript || "Results",
  UtteranceEnd: LiveTranscriptionEvents?.UtteranceEnd || "UtteranceEnd",
  Metadata: LiveTranscriptionEvents?.Metadata || "Metadata",
  SpeechStarted: LiveTranscriptionEvents?.SpeechStarted || "SpeechStarted",
  Unhandled: LiveTranscriptionEvents?.Unhandled || "Unhandled",
};

const hasRepeatingPattern = (text = "") => {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 12) return false;

  for (let size = 1; size <= 6; size += 1) {
    const seed = compact.slice(0, size);
    if (!seed) continue;

    let matched = 0;
    for (let i = 0; i < compact.length; i += size) {
      const chunk = compact.slice(i, i + size);
      if (!chunk) continue;
      if (seed.startsWith(chunk) || chunk === seed) {
        matched += chunk.length;
      }
    }

    if (matched / compact.length >= 0.82) {
      return true;
    }
  }

  return false;
};

const isLikelyGarbageTranscript = (text = "") => {
  const normalized = normalizeText(text);
  if (!normalized) return true;

  if (TIBETAN_CHAR_REGEX.test(normalized)) return true;
  if (KANNADA_CHAR_REGEX.test(normalized)) return true;

  const allowedChars = normalized.match(ALLOWED_TRANSCRIPT_CHAR_REGEX) || [];
  const allowedRatio = allowedChars.length / normalized.length;
  if (allowedRatio < 0.65) return true;

  const words = normalized.split(" ").filter(Boolean);
  if (words.length >= 6) {
    const uniqueWords = new Set(words);
    if (uniqueWords.size <= 2) return true;
  }

  const noSpace = normalized.replace(/\s+/g, "");
  if (noSpace.length >= 12) {
    const uniqueChars = new Set(noSpace.split(""));
    if (uniqueChars.size <= 2) return true;
  }

  if (hasRepeatingPattern(normalized)) return true;

  if (!normalized.includes(" ") && noSpace.length >= 24) {
    const uniqueChars = new Set(noSpace.split(""));
    if (uniqueChars.size <= 6) return true;
  }

  return false;
};

const SUSPICIOUS_BANGLA_PREFIXES = [
  "তিনি বাংলা",
  "কি বাংলা",
  "নাম পারক",
  "অন্যম পারক",
  "তিনি তার",
];

const isKnownBadBanglaGuess = (text = "") => {
  const value = normalizeText(text);
  return SUSPICIOUS_BANGLA_PREFIXES.some((prefix) => value.startsWith(prefix));
};

const prepareBanglaText = (text = "", language = "bn") => {
  let value = normalizeText(text);
  if (!value) return "";

  const normalizedLanguage = String(language || "").toLowerCase();
  if (!normalizedLanguage.startsWith("bn")) {
    return value;
  }

  value = value
    .replace(/\bআম্রা\b/g, "আমরা")
    .replace(/\bবাংলে\b/g, "বাংলায়")
    .replace(/\bবাঙ্গলে\b/g, "বাংলায়")
    .replace(/\bবাংগলে\b/g, "বাংলায়")
    .replace(/\bবাংলৈ\b/g, "বাংলায়")
    .replace(/\bবাঙলে\b/g, "বাংলায়")
    .replace(/\bকোত্ধা\b/g, "কথা")
    .replace(/\bকোত্তা\b/g, "কথা")
    .replace(/\bকোতা\b/g, "কথা")
    .replace(/\bকোথা\b/g, "কথা")
    .replace(/\bগোত্ধা\b/g, "কথা")
    .replace(/\bবল্তেশি\b/g, "বলতেছি")
    .replace(/\bবল্তেসি\b/g, "বলতেছি")
    .replace(/\bবল্তেশী\b/g, "বলতেছি")
    .replace(/\bবোল্তেশি\b/g, "বলতেছি")
    .replace(/\bবোল্তেসি\b/g, "বলতেছি")
    .replace(/(?<![\u0980-\u09FF])যাব(?![\u0980-\u09FF])/g, "যাবো");

  return value;
};

const sanitizeTranscript = (text = "", language = "bn") => {
  const normalized = prepareBanglaText(text, language);
  if (!normalized) return "";
  if (isLikelyGarbageTranscript(normalized)) return "";
  if (
    String(language || "")
      .toLowerCase()
      .startsWith("bn") &&
    isKnownBadBanglaGuess(normalized)
  ) {
    return "";
  }
  return normalized;
};

const looksDisplayableTranscript = (text = "", language = "bn") => {
  const value = normalizeText(text);
  if (!value) return false;

  const normalizedLanguage = String(language || "").toLowerCase();
  if (!normalizedLanguage.startsWith("bn")) {
    return value.length >= 2;
  }

  if (isKnownBadBanglaGuess(value)) return false;

  const banglaChars = value.match(/[\u0980-\u09FF]/g) || [];
  if (banglaChars.length >= 2) return true;

  return value.length >= 4;
};

const combineTranscriptSegments = (previous = "", current = "") => {
  const prev = normalizeText(previous);
  const next = normalizeText(current);

  if (!prev) return next;
  if (!next) return prev;

  if (next === prev) return next;
  if (next.startsWith(prev)) return next;
  if (next.includes(prev)) return next;
  if (prev.includes(next)) return prev;

  const prevWords = prev.split(" ");
  const nextWords = next.split(" ");
  const maxOverlap = Math.min(prevWords.length, nextWords.length);

  for (let size = maxOverlap; size > 0; size -= 1) {
    const prevTail = prevWords.slice(-size).join(" ");
    const nextHead = nextWords.slice(0, size).join(" ");
    if (prevTail === nextHead) {
      return `${prev} ${nextWords.slice(size).join(" ")}`.trim();
    }
  }

  return `${prev} ${next}`.trim();
};

const toWsUrl = (reqUrl = "") => {
  try {
    return new URL(reqUrl, "http://localhost");
  } catch {
    return null;
  }
};

const verifyTokenFromRequest = (req) => {
  if (!JWT_SECRET) {
    return { ok: true, reason: "JWT secret not configured; auth bypassed" };
  }

  const parsed = toWsUrl(req.url || "");
  const tokenFromQuery = parsed?.searchParams?.get("token");
  const authHeader = req.headers.authorization;
  const tokenFromHeader =
    typeof authHeader === "string"
      ? authHeader.replace(/^Bearer\s+/i, "")
      : null;
  const token = tokenFromQuery || tokenFromHeader;

  if (!token) {
    return { ok: false, message: "Missing auth token" };
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { ok: true, decoded };
  } catch {
    return { ok: false, message: "Invalid or expired token" };
  }
};

const resolveInputFormatFromMimeType = (mimeType = "") => {
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("webm")) return "webm";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("mp4") || value.includes("aac")) return "mp4";
  return null;
};

const createFfmpegArgs = (mimeType = "audio/webm") => {
  const inputFormat = resolveInputFormatFromMimeType(mimeType);
  const args = [
    "-loglevel",
    "error",
    "-fflags",
    "+genpts+nobuffer+discardcorrupt",
    "-probesize",
    "32768",
    "-analyzeduration",
    "0",
  ];

  if (inputFormat) {
    args.push("-f", inputFormat);
  }

  args.push(
    "-i",
    "pipe:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-acodec",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  );

  return args;
};

class DeepgramBridge {
  constructor() {
    this.bootError = null;
    this.ready = false;
    this.client = null;
    this.start();
  }

  start() {
    if (!DEEPGRAM_API_KEY) {
      this.bootError = new Error(
        "DEEPGRAM_API_KEY is not configured for speech transcription",
      );
      console.error("[speech] Deepgram init failed: missing DEEPGRAM_API_KEY");
      return;
    }

    try {
      this.client = createClient(DEEPGRAM_API_KEY);
      this.ready = true;
      console.log("[speech] Deepgram client ready for live transcription");
    } catch (error) {
      this.bootError = error;
      console.error(
        "[speech] Failed to initialize Deepgram client:",
        error.message,
      );
    }
  }

  resolveLanguage(language = "bn") {
    const normalized = String(language || "bn")
      .trim()
      .toLowerCase();
    if (normalized === "bn-bd") return "bn";
    return normalized || "bn";
  }

  resolveModel(language = "bn") {
    const effectiveLanguage = this.resolveLanguage(language);
    const configuredModel = String(DEFAULT_DEEPGRAM_MODEL || "nova-3").trim();

    if (
      effectiveLanguage.startsWith("bn") &&
      /^nova-2(?:-general)?$/i.test(configuredModel)
    ) {
      console.warn(
        `[speech] Overriding Deepgram model ${configuredModel} -> ${DEFAULT_BANGLA_MODEL} for Bangla because nova-2 does not support bn`,
      );
      return DEFAULT_BANGLA_MODEL;
    }

    return configuredModel || "nova-3";
  }

  createLiveConnection(language = "bn") {
    if (this.bootError) {
      throw this.bootError;
    }

    if (!this.client) {
      throw new Error("Deepgram client is not initialized");
    }

    const effectiveLanguage = this.resolveLanguage(language);
    const model = this.resolveModel(effectiveLanguage);

    console.log(
      `[speech] opening Deepgram live stream language=${effectiveLanguage} model=${model}`,
    );

    return this.client.listen.live({
      model,
      language: effectiveLanguage,
      encoding: "linear16",
      sample_rate: 16000,
      channels: 1,
      interim_results: true,
      punctuate: true,
      smart_format: true,
      vad_events: true,
      utterance_end_ms: 1000,
      endpointing: 400,
    });
  }
}

const createSpeechSession = (ws, transcriber) => {
  const sessionLabel = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const state = {
    ws,
    transcriber,
    sessionLabel,
    isRecording: false,
    isStopping: false,
    finalSent: false,
    language: "bn",
    mimeType: "audio/webm",
    chunkDurationMs: 400,
    deepgramConnection: null,
    deepgramOpen: false,
    ffmpegProcess: null,
    pendingPcmChunks: [],
    pendingPcmBytes: 0,
    confirmedTranscript: "",
    lastPartial: "",
    finalizeTimer: null,
    finalizeRequested: false,
    deepgramFinalizeSent: false,
    lastTranscriptAt: 0,
  };

  const send = (payload) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  };

  const clearFinalizeTimer = () => {
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
      state.finalizeTimer = null;
    }
  };

  const resetSessionState = () => {
    state.isRecording = false;
    state.isStopping = false;
    state.finalSent = false;
    state.confirmedTranscript = "";
    state.lastPartial = "";
    state.finalizeRequested = false;
    state.deepgramFinalizeSent = false;
    state.lastTranscriptAt = 0;
    state.pendingPcmChunks = [];
    state.pendingPcmBytes = 0;
    clearFinalizeTimer();
    closeDeepgramConnection();
    killFfmpegProcess();
  };

  const scheduleFinalizeFlush = (delayMs = FINALIZE_GRACE_MS) => {
    clearFinalizeTimer();
    state.finalizeTimer = setTimeout(() => {
      finalizeSession();
    }, delayMs);
  };

  const closeDeepgramConnection = () => {
    if (!state.deepgramConnection) return;

    try {
      if (typeof state.deepgramConnection.requestClose === "function") {
        state.deepgramConnection.requestClose();
      } else if (typeof state.deepgramConnection.finish === "function") {
        state.deepgramConnection.finish();
      } else if (typeof state.deepgramConnection.disconnect === "function") {
        state.deepgramConnection.disconnect();
      }
    } catch (error) {
      console.warn(
        `[speech] session=${state.sessionLabel} failed to close Deepgram connection:`,
        error.message,
      );
    }

    state.deepgramConnection = null;
    state.deepgramOpen = false;
  };

  const killFfmpegProcess = () => {
    const process = state.ffmpegProcess;
    if (!process) return;

    state.ffmpegProcess = null;

    try {
      if (process.stdin && !process.stdin.destroyed) {
        process.stdin.destroy();
      }
    } catch {
      // noop
    }

    try {
      if (!process.killed) {
        process.kill("SIGKILL");
      }
    } catch {
      // noop
    }
  };

  const finalizeSession = () => {
    if (state.finalSent) return;

    state.finalSent = true;
    state.isRecording = false;
    state.isStopping = false;
    clearFinalizeTimer();

    const finalText = normalizeText(
      state.lastPartial || state.confirmedTranscript || "",
    );

    if (finalText) {
      state.confirmedTranscript = finalText;
      state.lastPartial = finalText;
    }

    console.log(
      `[speech] session=${state.sessionLabel} sending final text="${finalText}"`,
    );
    send({ type: "final", text: finalText });

    closeDeepgramConnection();
    killFfmpegProcess();
  };

  const flushPendingPcmChunks = () => {
    if (!state.deepgramConnection || !state.deepgramOpen) return;
    if (!state.pendingPcmChunks.length) return;

    for (let i = 0; i < state.pendingPcmChunks.length; i += 1) {
      const chunk = state.pendingPcmChunks[i];
      try {
        state.deepgramConnection.send(chunk);
      } catch (error) {
        console.warn(
          `[speech] session=${state.sessionLabel} failed to flush PCM chunk:`,
          error.message,
        );
        break;
      }
    }

    state.pendingPcmChunks = [];
    state.pendingPcmBytes = 0;
  };

  const sendPcmToDeepgram = (chunk) => {
    if (!chunk || !chunk.length) return;

    if (state.deepgramConnection && state.deepgramOpen) {
      try {
        state.deepgramConnection.send(chunk);
      } catch (error) {
        console.warn(
          `[speech] session=${state.sessionLabel} failed to send PCM chunk:`,
          error.message,
        );
      }
      return;
    }

    state.pendingPcmChunks.push(chunk);
    state.pendingPcmBytes += chunk.length;

    const maxPendingBytes = 512 * 1024;
    while (
      state.pendingPcmBytes > maxPendingBytes &&
      state.pendingPcmChunks.length
    ) {
      const removed = state.pendingPcmChunks.shift();
      state.pendingPcmBytes -= removed?.length || 0;
    }
  };

  const applyTranscript = (rawTranscript, { isFinal = false } = {}) => {
    const transcript = sanitizeTranscript(rawTranscript, state.language);
    if (!transcript) {
      if (rawTranscript) {
        console.log(
          `[speech] session=${state.sessionLabel} discarded transcript="${rawTranscript}"`,
        );
      }
      return "";
    }

    const combined = combineTranscriptSegments(
      state.confirmedTranscript,
      transcript,
    );

    if (!isFinal && !looksDisplayableTranscript(combined, state.language)) {
      return "";
    }

    if (isFinal) {
      state.confirmedTranscript = combined;
    }

    if (combined && combined !== state.lastPartial) {
      state.lastPartial = combined;
      console.log(
        `[speech] session=${state.sessionLabel} sending partial text="${combined}" isFinal=${isFinal}`,
      );
      send({ type: "partial", text: combined });
    }

    return combined;
  };

  const requestDeepgramFinalize = (reason = "stop") => {
    state.finalizeRequested = true;

    console.log(
      `[speech] session=${state.sessionLabel} requesting Deepgram finalize reason=${reason}`,
    );

    if (
      state.deepgramConnection &&
      state.deepgramOpen &&
      !state.deepgramFinalizeSent
    ) {
      try {
        if (typeof state.deepgramConnection.finalize === "function") {
          state.deepgramConnection.finalize();
          state.deepgramFinalizeSent = true;
        }
      } catch (error) {
        console.warn(
          `[speech] session=${state.sessionLabel} Deepgram finalize failed:`,
          error.message,
        );
      }
    }

    scheduleFinalizeFlush(FINALIZE_GRACE_MS);
  };

  const attachDeepgramEvents = (connection) => {
    connection.on(DG_EVENTS.Open, () => {
      console.log(`[speech] session=${state.sessionLabel} Deepgram open`);
      state.deepgramOpen = true;
      flushPendingPcmChunks();

      if (state.isStopping && state.finalizeRequested) {
        requestDeepgramFinalize("post-open");
      }
    });

    connection.on(DG_EVENTS.Transcript, (payload) => {
      const rawTranscript = normalizeText(
        payload?.channel?.alternatives?.[0]?.transcript || "",
      );
      const isFinal = Boolean(payload?.is_final);
      const speechFinal = Boolean(
        payload?.speech_final || payload?.from_finalize,
      );

      if (rawTranscript) {
        state.lastTranscriptAt = Date.now();
        applyTranscript(rawTranscript, { isFinal });
      }

      if (state.isStopping) {
        scheduleFinalizeFlush(speechFinal || isFinal ? 250 : FINALIZE_GRACE_MS);
      }
    });

    connection.on(DG_EVENTS.UtteranceEnd, () => {
      console.log(
        `[speech] session=${state.sessionLabel} Deepgram utterance end`,
      );
      if (state.isStopping) {
        scheduleFinalizeFlush(250);
      } else if (state.isRecording && state.lastPartial) {
        send({ type: "utterance-end" });
      }
    });

    connection.on(DG_EVENTS.Metadata, (payload) => {
      console.log(
        `[speech] session=${state.sessionLabel} Deepgram metadata request_id=${payload?.request_id || "n/a"}`,
      );
    });

    connection.on(DG_EVENTS.SpeechStarted, () => {
      console.log(
        `[speech] session=${state.sessionLabel} Deepgram detected speech`,
      );
    });

    connection.on(DG_EVENTS.Unhandled, (payload) => {
      console.log(
        `[speech] session=${state.sessionLabel} Deepgram unhandled event:`,
        payload,
      );
    });

    connection.on(DG_EVENTS.Close, () => {
      console.log(`[speech] session=${state.sessionLabel} Deepgram close`);
      state.deepgramOpen = false;
      if (state.isStopping) {
        finalizeSession();
      }
    });

    connection.on(DG_EVENTS.Error, (error) => {
      console.error(
        `[speech] session=${state.sessionLabel} Deepgram error:`,
        error?.message || error,
      );

      if (state.isStopping) {
        finalizeSession();
        return;
      }

      send({
        type: "status",
        message:
          "Bangla speech recognition was interrupted. Using the text captured so far.",
      });
      state.isStopping = true;
      finalizeSession();
    });
  };

  const startFfmpegTranscoder = () => {
    const ffmpegPath = ffmpegInstaller.path;
    const args = createFfmpegArgs(state.mimeType);

    console.log(
      `[speech] session=${state.sessionLabel} starting ffmpeg mimeType=${state.mimeType} args=${args.join(" ")}`,
    );

    const ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    state.ffmpegProcess = ffmpegProcess;

    ffmpegProcess.stdout.on("data", (chunk) => {
      sendPcmToDeepgram(chunk);
    });

    ffmpegProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        console.warn(
          `[speech] session=${state.sessionLabel} ffmpeg: ${message}`,
        );
      }
    });

    ffmpegProcess.on("error", (error) => {
      console.error(
        `[speech] session=${state.sessionLabel} ffmpeg error:`,
        error.message,
      );
      if (!state.isStopping) {
        send({
          type: "error",
          message: "Speech audio conversion failed on the server.",
        });
        state.isStopping = true;
      }
      finalizeSession();
    });

    ffmpegProcess.on("close", (code, signal) => {
      console.log(
        `[speech] session=${state.sessionLabel} ffmpeg close code=${code} signal=${signal || "n/a"}`,
      );
      state.ffmpegProcess = null;
      if (state.isStopping) {
        requestDeepgramFinalize("ffmpeg-close");
      }
    });
  };

  const startRecording = (payload = {}) => {
    resetSessionState();

    state.language = payload.language || "bn";
    state.mimeType = payload.mimeType || "audio/webm";
    state.chunkDurationMs = Number(payload.chunkDurationMs || 400);
    state.isRecording = true;

    if (state.transcriber.bootError) {
      console.error(
        `[speech] session=${state.sessionLabel} Deepgram boot error:`,
        state.transcriber.bootError.message,
      );
      send({
        type: "error",
        message:
          state.transcriber.bootError.message ||
          "Deepgram client is not initialized",
      });
      state.isRecording = false;
      return;
    }

    try {
      state.deepgramConnection = state.transcriber.createLiveConnection(
        state.language,
      );
      attachDeepgramEvents(state.deepgramConnection);
      startFfmpegTranscoder();

      console.log(
        `[speech] session=${state.sessionLabel} start language=${state.language} mimeType=${state.mimeType} chunkDurationMs=${state.chunkDurationMs}`,
      );
      send({ type: "ready", message: "Speech stream started" });
    } catch (error) {
      console.error(
        `[speech] session=${state.sessionLabel} failed to start speech session:`,
        error.message,
      );
      send({
        type: "error",
        message: error.message || "Unable to start speech recognition",
      });
      state.isRecording = false;
      state.isStopping = false;
      closeDeepgramConnection();
      killFfmpegProcess();
    }
  };

  const stopRecording = async () => {
    if (!state.isRecording && !state.isStopping) return;

    state.isRecording = false;
    state.isStopping = true;
    clearFinalizeTimer();

    console.log(`[speech] session=${state.sessionLabel} stop requested`);

    if (state.ffmpegProcess?.stdin && !state.ffmpegProcess.stdin.destroyed) {
      try {
        state.ffmpegProcess.stdin.end();
      } catch (error) {
        console.warn(
          `[speech] session=${state.sessionLabel} failed to end ffmpeg stdin:`,
          error.message,
        );
        requestDeepgramFinalize("ffmpeg-stdin-end-failed");
      }
    } else {
      requestDeepgramFinalize("no-ffmpeg-stdin");
    }

    scheduleFinalizeFlush(FINALIZE_GRACE_MS + 400);
  };

  const pushChunk = (buffer) => {
    if (!buffer || !buffer.length) return;
    if (!state.isRecording && !state.isStopping) return;

    const input = state.ffmpegProcess?.stdin;
    if (!input || input.destroyed || input.writableEnded) {
      console.warn(
        `[speech] session=${state.sessionLabel} dropped audio chunk because ffmpeg stdin is unavailable`,
      );
      return;
    }

    try {
      input.write(buffer);
    } catch (error) {
      console.warn(
        `[speech] session=${state.sessionLabel} failed to write audio chunk:`,
        error.message,
      );
    }
  };

  const cleanup = () => {
    clearFinalizeTimer();
    state.isRecording = false;
    state.isStopping = false;
    closeDeepgramConnection();
    killFfmpegProcess();
    state.pendingPcmChunks = [];
    state.pendingPcmBytes = 0;
  };

  return {
    state,
    send,
    startRecording,
    stopRecording,
    pushChunk,
    cleanup,
  };
};

const initializeSpeechWebSocketServer = (httpServer) => {
  const deepgramBridge = new DeepgramBridge();

  const speechWss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
  });

  speechWss.on("connection", (ws, req) => {
    const auth = verifyTokenFromRequest(req);
    console.log(
      `[speech] incoming connection from ${req.socket?.remoteAddress || "unknown"} authOk=${auth.ok} reason=${auth.reason || auth.message || "n/a"}`,
    );

    if (!auth.ok) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: auth.message || "Unauthorized",
        }),
      );
      ws.close(1008, "Unauthorized");
      return;
    }

    if (deepgramBridge.bootError) {
      console.error(
        "[speech] Deepgram boot error present:",
        deepgramBridge.bootError.message,
      );
    }

    const session = createSpeechSession(ws, deepgramBridge);

    ws.on("message", async (raw, isBinary) => {
      try {
        if (isBinary) {
          session.pushChunk(Buffer.from(raw));
          return;
        }

        const text = raw.toString();
        const payload = JSON.parse(text);

        console.log(
          `[speech] session=${session.state.sessionLabel} received message type=${payload.type}`,
        );

        if (payload.type === "start") {
          session.startRecording(payload);
        } else if (payload.type === "stop") {
          await session.stopRecording();
        } else if (payload.type === "audio") {
          if (!payload.data) return;
          session.pushChunk(Buffer.from(payload.data, "base64"));
        } else if (payload.type === "ping") {
          session.send({ type: "pong" });
        }
      } catch (error) {
        console.error(
          `[speech] session=${session.state.sessionLabel} malformed message error:`,
          error.message,
        );
        session.send({
          type: "error",
          message: `Malformed speech message: ${error.message}`,
        });
      }
    });

    ws.on("close", (code, reasonBuf) => {
      console.log(
        `[speech] session=${session.state.sessionLabel} socket closed code=${code} reason=${reasonBuf?.toString() || "n/a"}`,
      );
      session.cleanup();
    });

    ws.on("error", (error) => {
      console.error(
        `[speech] session=${session.state.sessionLabel} socket error:`,
        error.message,
      );
      session.cleanup();
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(request.url || "", "http://localhost").pathname;
    } catch {
      pathname = "";
    }

    if (pathname !== "/ws/speech") {
      return;
    }

    speechWss.handleUpgrade(request, socket, head, (ws) => {
      speechWss.emit("connection", ws, request);
    });
  });

  console.log("[speech] WebSocket endpoint ready at /ws/speech");
  return speechWss;
};

module.exports = {
  initializeSpeechWebSocketServer,
};
