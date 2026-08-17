const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { spawn } = require("child_process");
const readline = require("readline");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { WebSocketServer } = require("ws");

const JWT_SECRET = process.env.JWT_SECRET_KEY;
const CHUNK_TRANSCRIBE_INTERVAL_MS = Number(
  process.env.SPEECH_TRANSCRIBE_INTERVAL_MS || 900,
);
const MAX_CHUNKS_IN_BUFFER = Number(process.env.SPEECH_MAX_CHUNKS || 6);
const MAX_TRANSCRIBE_WINDOW_MS = Number(
  process.env.SPEECH_MAX_WINDOW_MS || 5000,
);
const SPEECH_TRANSCRIBE_TIMEOUT_MS = Number(
  process.env.SPEECH_TRANSCRIBE_TIMEOUT_MS || 45000,
);

const PYTHON_WORKER_PATH = path.join(__dirname, "whisperWorker.py");

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const SPEECH_TEMP_DIR = path.join(os.tmpdir(), "connect-speech");
ensureDir(SPEECH_TEMP_DIR);

const normalizeText = (text = "") => String(text).replace(/\s+/g, " ").trim();

const TIBETAN_CHAR_REGEX = /[\u0F00-\u0FFF]/;
const ALLOWED_TRANSCRIPT_CHAR_REGEX =
  /[\u0980-\u09FFa-zA-Z0-9\s.,!?;:'"()\-_/&@#+]/g;

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

  // Strong signal of bad decode we repeatedly observed in logs.
  if (TIBETAN_CHAR_REGEX.test(normalized)) return true;

  // If almost all chars are outside Bangla/Latin/normal punctuation, drop it.
  const allowedChars = normalized.match(ALLOWED_TRANSCRIPT_CHAR_REGEX) || [];
  const allowedRatio = allowedChars.length / normalized.length;
  if (allowedRatio < 0.65) return true;

  // Repeated-token hallucination guard, e.g. "x x x x x ...".
  const words = normalized.split(" ").filter(Boolean);
  if (words.length >= 6) {
    const uniqueWords = new Set(words);
    if (uniqueWords.size <= 2) return true;
  }

  // Repeated single-char stream guard.
  const noSpace = normalized.replace(/\s+/g, "");
  if (noSpace.length >= 12) {
    const uniqueChars = new Set(noSpace.split(""));
    if (uniqueChars.size <= 2) return true;
  }

  // Repeated syllable/pattern hallucination guard (e.g. কাকেকে..., ༼༼༼...).
  if (hasRepeatingPattern(normalized)) return true;

  // Long single-token lines with very low unique char diversity are usually junk.
  if (!normalized.includes(" ") && noSpace.length >= 24) {
    const uniqueChars = new Set(noSpace.split(""));
    if (uniqueChars.size <= 6) return true;
  }

  return false;
};

const sanitizeTranscript = (text = "") => {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  if (isLikelyGarbageTranscript(normalized)) return "";
  return normalized;
};

const mergeOverlappingText = (previous = "", current = "") => {
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

  return next;
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

const convertWebmToWav16k = (sourcePath, targetPath) =>
  new Promise((resolve, reject) => {
    const ffmpegPath = ffmpegInstaller.path;

    const args = [
      "-y",
      "-i",
      sourcePath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      targetPath,
    ];

    const ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorBuffer = "";

    ffmpegProcess.stderr.on("data", (chunk) => {
      errorBuffer += chunk.toString();
    });

    ffmpegProcess.on("error", (error) => {
      reject(error);
    });

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code}: ${errorBuffer.slice(-1500)}`,
          ),
        );
      }
    });
  });

class PythonWhisperBridge {
  constructor() {
    this.proc = null;
    this.requests = new Map();
    this.counter = 0;
    this.bootError = null;
    this.ready = false;
    this.spawnedAt = Date.now();
    this.modelSize = this.resolveEffectiveModelSize();
    this.start();
  }

  resolveEffectiveModelSize() {
    const requested = (process.env.WHISPER_MODEL_SIZE || "small").trim();
    const lower = requested.toLowerCase();
    const allowHeavy = /^1|true|yes$/i.test(
      String(process.env.WHISPER_ALLOW_HEAVY_MODEL || ""),
    );
    const isHeavy =
      lower === "medium" ||
      lower.startsWith("large") ||
      lower.includes("distil-large");

    if (process.platform === "win32" && isHeavy && !allowHeavy) {
      console.warn(
        `[speech] WHISPER_MODEL_SIZE=${requested} can cause very long cold starts on Windows CPU. Auto-downgrading to "small" for real-time responsiveness. Set WHISPER_ALLOW_HEAVY_MODEL=true to force heavy models.`,
      );
      return "small";
    }

    return requested || "small";
  }

  start() {
    const preferredPython = process.env.WHISPER_PYTHON_BIN || "python";

    console.log(
      `[speech] Spawning Whisper worker: bin="${preferredPython}" script="${PYTHON_WORKER_PATH}" model="${this.modelSize}"`,
    );

    try {
      this.proc = spawn(preferredPython, [PYTHON_WORKER_PATH], {
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          WHISPER_MODEL_SIZE: this.modelSize,
          HF_HUB_DISABLE_SYMLINKS_WARNING:
            process.env.HF_HUB_DISABLE_SYMLINKS_WARNING || "1",
          // Windows defaults Python stdio to the system codepage (e.g. cp1252),
          // which cannot encode Bangla Unicode and crashes the worker.
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.bootError = error;
      console.error("[speech] Failed to spawn Whisper worker:", error.message);
      return;
    }

    const rl = readline.createInterface({ input: this.proc.stdout });

    rl.on("line", (line) => {
      console.log("[speech-whisper-worker:stdout]", line);

      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }

      if (payload.type === "ready") {
        this.ready = true;
        const loadSeconds = ((Date.now() - this.spawnedAt) / 1000).toFixed(1);
        console.log(
          `[speech] Whisper model ready in ${loadSeconds}s: model=${payload.model} device=${payload.device} compute=${payload.compute_type} language=${payload.language}`,
        );
        return;
      }

      const reqId = payload?.id;
      if (!reqId || !this.requests.has(reqId)) return;

      const req = this.requests.get(reqId);
      this.requests.delete(reqId);

      if (payload.type === "result") {
        req.resolve(payload.text || "");
      } else {
        req.reject(new Error(payload.message || "Transcription failed"));
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const output = chunk.toString();
      if (output.trim()) {
        console.error("[speech-whisper-worker:stderr]", output.trim());
      }
    });

    this.proc.on("error", (error) => {
      this.bootError = error;
      console.error("[speech] Whisper worker process error:", error.message);
      this.failAllPending(error);
    });

    this.proc.on("close", (code) => {
      console.error(`[speech] Whisper worker exited with code ${code}`);
      const err = new Error(`Whisper worker exited with code ${code}`);
      this.failAllPending(err);
      this.proc = null;
      this.ready = false;
    });
  }

  failAllPending(error) {
    this.requests.forEach((req) => req.reject(error));
    this.requests.clear();
  }

  transcribe(audioPath, language = "bn") {
    if (this.bootError) {
      return Promise.reject(this.bootError);
    }

    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      return Promise.reject(new Error("Whisper worker is not running"));
    }

    const id = `tx-${Date.now()}-${this.counter++}`;
    const startedAt = Date.now();

    console.log(
      `[speech] -> transcribe request id=${id} language=${language} audioPath=${audioPath}`,
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        reject(
          new Error(
            `Transcription timed out after ${SPEECH_TRANSCRIBE_TIMEOUT_MS}ms (worker may still be loading or overloaded)`,
          ),
        );
      }, SPEECH_TRANSCRIBE_TIMEOUT_MS);

      this.requests.set(id, {
        resolve: (text) => {
          clearTimeout(timeout);
          console.log(
            `[speech] <- transcribe result id=${id} durationMs=${Date.now() - startedAt} textLength=${text.length} preview="${text.slice(0, 80)}"`,
          );
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timeout);
          console.warn(
            `[speech] <- transcribe failed id=${id} durationMs=${Date.now() - startedAt} error=${error.message}`,
          );
          reject(error);
        },
      });

      const payload = {
        type: "transcribe",
        id,
        audioPath,
        language,
      };

      try {
        this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.requests.delete(id);
        reject(error);
      }
    });
  }
}

const unlinkSafe = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // no-op
  }
};

const estimateWindowChunks = (msPerChunk = 800) => {
  const chunks = Math.ceil(MAX_TRANSCRIBE_WINDOW_MS / msPerChunk);
  return Math.max(4, Math.min(MAX_CHUNKS_IN_BUFFER, chunks));
};

const createSpeechSession = (ws, transcriber) => {
  const sessionLabel = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const state = {
    ws,
    transcriber,
    sessionLabel,
    isRecording: false,
    language: "bn",
    mimeType: "audio/webm",
    chunks: [],
    headerChunk: null,
    chunkDurationMs: 800,
    lastPartial: "",
    finalTranscript: "",
    transcribing: false,
    intervalId: null,
    queue: Promise.resolve(),
    consecutiveEmptyResults: 0,
    lastStatusSentAt: 0,
  };

  const send = (payload) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  };

  const resetSessionAudio = () => {
    state.chunks = [];
    state.headerChunk = null;
    state.lastPartial = "";
    state.finalTranscript = "";
    state.queue = Promise.resolve();
    state.consecutiveEmptyResults = 0;
    state.lastStatusSentAt = 0;
  };

  const pushChunk = (buffer) => {
    if (!buffer || !buffer.length) return;

    // Keep the first container/header chunk stable; FFmpeg decode can fail
    // when we trim away the initial WebM header in rolling windows.
    if (!state.headerChunk) {
      state.headerChunk = buffer;
      console.log(
        `[speech] session=${state.sessionLabel} header chunk captured bytes=${buffer.length}`,
      );
      return;
    }

    state.chunks.push(buffer);

    const maxByDuration = estimateWindowChunks(state.chunkDurationMs);
    const maxAllowed = Math.min(MAX_CHUNKS_IN_BUFFER, maxByDuration);
    if (state.chunks.length > maxAllowed) {
      state.chunks.splice(0, state.chunks.length - maxAllowed);
    }

    console.log(
      `[speech] session=${state.sessionLabel} chunk received bytes=${buffer.length} bufferedChunks=${state.chunks.length}`,
    );
  };

  // Core transcription logic. Always invoked through the `queue` chain (see
  // `runTranscription` below) so a `final` request can never be silently
  // dropped just because a partial-window transcription happened to be
  // in-flight at the same moment (this was the root cause of "no
  // recognition" reports — stop() arrived mid-transcription and the final
  // pass was skipped entirely).
  const runTranscriptionCore = async ({ isFinal = false } = {}) => {
    if (!state.headerChunk && state.chunks.length === 0) {
      console.log(
        `[speech] session=${state.sessionLabel} nothing buffered to transcribe isFinal=${isFinal}`,
      );
      if (isFinal) {
        send({ type: "final", text: state.lastPartial || "" });
        state.finalTranscript = state.lastPartial || "";
      }
      return;
    }

    state.transcribing = true;
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const webmPath = path.join(SPEECH_TEMP_DIR, `${sessionId}.webm`);
    const wavPath = path.join(SPEECH_TEMP_DIR, `${sessionId}.wav`);

    try {
      const bufferedChunks = state.headerChunk
        ? [state.headerChunk, ...state.chunks]
        : state.chunks;
      const audioBuffer = Buffer.concat(bufferedChunks);

      console.log(
        `[speech] session=${state.sessionLabel} runTranscription isFinal=${isFinal} chunkCount=${state.chunks.length} totalBytes=${audioBuffer.length}`,
      );

      await fs.promises.writeFile(webmPath, audioBuffer);
      await convertWebmToWav16k(webmPath, wavPath);

      const wavStat = await fs.promises.stat(wavPath).catch(() => null);
      console.log(
        `[speech] session=${state.sessionLabel} ffmpeg conversion done wavBytes=${wavStat ? wavStat.size : "unknown"}`,
      );

      const rawTranscript = normalizeText(
        await state.transcriber.transcribe(wavPath, state.language || "bn"),
      );

      console.log(
        `[speech] session=${state.sessionLabel} raw transcript="${rawTranscript}" (length=${rawTranscript.length})`,
      );

      const transcript = sanitizeTranscript(rawTranscript);

      if (!transcript && rawTranscript) {
        console.log(
          `[speech] session=${state.sessionLabel} dropped low-confidence/garbage transcript window`,
        );
      }

      if (!transcript) {
        state.consecutiveEmptyResults += 1;
      } else {
        state.consecutiveEmptyResults = 0;
      }

      if (
        state.consecutiveEmptyResults >= 6 &&
        Date.now() - state.lastStatusSentAt > 5000
      ) {
        state.lastStatusSentAt = Date.now();
        send({
          type: "status",
          message:
            "No clear Bangla speech detected yet. Please speak closer to the mic in a quieter environment.",
        });
      }

      const merged = mergeOverlappingText(state.lastPartial, transcript);

      if (merged && merged !== state.lastPartial) {
        state.lastPartial = merged;
        console.log(
          `[speech] session=${state.sessionLabel} sending ${isFinal ? "final" : "partial"} text="${merged}"`,
        );
        send({ type: isFinal ? "final" : "partial", text: merged });
      } else if (isFinal) {
        console.log(
          `[speech] session=${state.sessionLabel} sending final (unchanged) text="${state.lastPartial || ""}"`,
        );
        send({ type: "final", text: state.lastPartial || "" });
      } else {
        console.log(
          `[speech] session=${state.sessionLabel} no new text to send (merged matches lastPartial or empty)`,
        );
      }

      if (isFinal) {
        state.finalTranscript = state.lastPartial || "";
      }
    } catch (error) {
      // Most chunk-level failures are recoverable (e.g., timing/container edge cases).
      // Keep the stream alive and let next windows recover.
      if (isFinal) {
        send({ type: "final", text: state.lastPartial || "" });
      }
      console.warn(
        `[speech] session=${state.sessionLabel} chunk transcription failed:`,
        error.message,
      );
    } finally {
      state.transcribing = false;
      await unlinkSafe(webmPath);
      await unlinkSafe(wavPath);
    }
  };

  // Wrapper that serializes all transcription runs through `state.queue`.
  // - `final` requests are ALWAYS queued and guaranteed to run (even if a
  //   partial window is currently mid-transcription).
  // - `partial` requests are skipped (not queued) if a run is already in
  //   flight, so we don't build up a backlog of stale windows.
  const runTranscription = ({ isFinal = false } = {}) => {
    if (!isFinal && state.transcribing) {
      console.log(
        `[speech] session=${state.sessionLabel} skip overlapping partial window (transcription already in flight)`,
      );
      return state.queue;
    }

    state.queue = state.queue
      .then(() => runTranscriptionCore({ isFinal }))
      .catch((error) => {
        console.warn(
          `[speech] session=${state.sessionLabel} queued transcription failed:`,
          error?.message || error,
        );
      });

    return state.queue;
  };

  const stopScheduler = () => {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  };

  const startScheduler = () => {
    stopScheduler();
    state.intervalId = setInterval(() => {
      runTranscription({ isFinal: false }).catch(() => {
        // already handled
      });
    }, CHUNK_TRANSCRIBE_INTERVAL_MS);
  };

  const startRecording = (payload = {}) => {
    state.language = payload.language || "bn";
    state.mimeType = payload.mimeType || "audio/webm";
    state.chunkDurationMs = Number(payload.chunkDurationMs || 800);
    state.isRecording = true;
    resetSessionAudio();
    startScheduler();
    console.log(
      `[speech] session=${state.sessionLabel} start language=${state.language} mimeType=${state.mimeType} chunkDurationMs=${state.chunkDurationMs}`,
    );
    send({ type: "ready", message: "Speech stream started" });

    if (!state.transcriber.ready && !state.transcriber.bootError) {
      send({
        type: "status",
        message:
          "Speech model is still loading on the server (larger models can take a while on first run). Your speech will still be captured; transcription will begin as soon as it's ready.",
      });
    }
  };

  const stopRecording = async () => {
    state.isRecording = false;
    stopScheduler();
    console.log(`[speech] session=${state.sessionLabel} stop requested`);
    await runTranscription({ isFinal: true });
  };

  return {
    state,
    send,
    startRecording,
    stopRecording,
    pushChunk,
    cleanup: () => {
      stopScheduler();
      state.isRecording = false;
      state.chunks = [];
      state.headerChunk = null;
    },
  };
};

const initializeSpeechWebSocketServer = (httpServer) => {
  const whisperBridge = new PythonWhisperBridge();

  // IMPORTANT: use noServer mode so we don't interfere with Socket.IO upgrade flow.
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

    if (!whisperBridge.ready && !whisperBridge.bootError) {
      console.warn(
        "[speech] Whisper worker not confirmed ready yet — first transcription may be slow or fail if model is still loading.",
      );
      ws.send(
        JSON.stringify({
          type: "status",
          message:
            "Speech model is still loading on the server (larger models can take a while on first run). Your speech will still be captured; transcription will begin as soon as it's ready.",
        }),
      );
    }

    if (whisperBridge.bootError) {
      console.error(
        "[speech] Whisper worker boot error present:",
        whisperBridge.bootError.message,
      );
    }

    const session = createSpeechSession(ws, whisperBridge);

    ws.on("message", async (raw, isBinary) => {
      try {
        if (isBinary) {
          if (!session.state.isRecording) {
            console.log(
              `[speech] session=${session.state.sessionLabel} dropped binary chunk (not recording)`,
            );
            return;
          }
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
          if (!session.state.isRecording || !payload.data) return;
          const data = Buffer.from(payload.data, "base64");
          session.pushChunk(data);
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
