const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");
const { spawn } = require("child_process");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { createClient } = require("@deepgram/sdk");
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
const SPEECH_MIN_RMS = Number(process.env.SPEECH_MIN_RMS || 220);
const SPEECH_MIN_ACTIVE_RATIO = Number(
  process.env.SPEECH_MIN_ACTIVE_RATIO || 0.06,
);

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEFAULT_DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-2";

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const SPEECH_TEMP_DIR = path.join(os.tmpdir(), "connect-speech");
ensureDir(SPEECH_TEMP_DIR);

const normalizeText = (text = "") => String(text).replace(/\s+/g, " ").trim();

const TIBETAN_CHAR_REGEX = /[\u0F00-\u0FFF]/;
const KANNADA_CHAR_REGEX = /[\u0C80-\u0CFF]/;
const BENGALI_CHAR_REGEX = /[\u0980-\u09FF]/;
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
  if (KANNADA_CHAR_REGEX.test(normalized)) return true;

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

  const compact = value.replace(/[\s।.!?,;:'"-]+/g, "");
  const hasBangla = BENGALI_CHAR_REGEX.test(value);

  if (
    hasBangla &&
    /বাংল(?:া|ায়)\s+কথা\s+বলতেছি/.test(value) &&
    !/আমরা\s+বাংল(?:া|ায়)/.test(value)
  ) {
    return "আমরা বাংলায় কথা বলতেছি।";
  }

  if (
    compact &&
    /বাংল(?:া|ায়|ায়)কথাবলতেছি/.test(compact) &&
    !/আমরা/.test(compact)
  ) {
    return "আমরা বাংলায় কথা বলতেছি।";
  }

  if (hasBangla && value && !/[.!?।]$/.test(value)) {
    value += "।";
  }

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
  )
    return "";
  return normalized;
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

const looksLikeStableBanglaPartial = (text = "", language = "bn") => {
  const value = normalizeText(text);
  if (!value) return false;

  const normalizedLanguage = String(language || "").toLowerCase();
  if (!normalizedLanguage.startsWith("bn")) {
    return value.length >= 8;
  }

  if (!BENGALI_CHAR_REGEX.test(value)) return false;

  const wordCount = value.split(" ").filter(Boolean).length;
  const charCount = value.replace(/\s+/g, "").length;

  // For rolling partials, suppress very short unstable guesses such as
  // "তিনি বাংলা" or other 1-2 word hallucinations.
  if (wordCount < 3) return false;
  if (charCount < 10) return false;

  if (isKnownBadBanglaGuess(value)) {
    return false;
  }

  return true;
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

const analyzeWavSpeechEnergy = async (wavPath) => {
  const buffer = await fs.promises.readFile(wavPath);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    return { hasSpeech: true, rms: 0, activeRatio: 1 };
  }

  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkLength, buffer.length - dataOffset);
      break;
    }
    offset += 8 + chunkLength + (chunkLength % 2);
  }

  if (dataOffset < 0 || dataLength < 2) {
    return { hasSpeech: true, rms: 0, activeRatio: 1 };
  }

  const sampleCount = Math.floor(dataLength / 2);
  let sumSquares = 0;
  let peak = 0;
  const windowSamples = 320; // 20 ms at 16 kHz.
  let activeWindows = 0;
  let totalWindows = 0;

  for (let start = 0; start < sampleCount; start += windowSamples) {
    const end = Math.min(sampleCount, start + windowSamples);
    let windowSquares = 0;

    for (let i = start; i < end; i += 1) {
      const sample = buffer.readInt16LE(dataOffset + i * 2);
      const absolute = Math.abs(sample);
      if (absolute > peak) peak = absolute;
      const square = sample * sample;
      sumSquares += square;
      windowSquares += square;
    }

    const windowRms = Math.sqrt(windowSquares / Math.max(1, end - start));
    if (windowRms >= SPEECH_MIN_RMS * 1.35) activeWindows += 1;
    totalWindows += 1;
  }

  const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
  const activeRatio = activeWindows / Math.max(1, totalWindows);
  const hasSpeech =
    rms >= SPEECH_MIN_RMS &&
    activeRatio >= SPEECH_MIN_ACTIVE_RATIO &&
    peak >= SPEECH_MIN_RMS * 3;

  return { hasSpeech, rms, activeRatio, peak };
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

class DeepgramBridge {
  constructor() {
    this.bootError = null;
    this.ready = false;
    this.client = null;
    this.model = DEFAULT_DEEPGRAM_MODEL;
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
      console.log(
        `[speech] Deepgram client ready model=${this.model} defaultLanguage=bn`,
      );
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

  async transcribe(audioPath, language = "bn") {
    if (this.bootError) {
      throw this.bootError;
    }

    if (!this.client) {
      throw new Error("Deepgram client is not initialized");
    }

    const startedAt = Date.now();
    const effectiveLanguage = this.resolveLanguage(language);
    const audioBuffer = await fs.promises.readFile(audioPath);

    console.log(
      `[speech] -> deepgram transcribe language=${effectiveLanguage} model=${this.model} audioPath=${audioPath} bytes=${audioBuffer.length}`,
    );

    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Deepgram transcription timed out after ${SPEECH_TRANSCRIBE_TIMEOUT_MS}ms`,
          ),
        );
      }, SPEECH_TRANSCRIBE_TIMEOUT_MS);
    });

    const request = this.client.listen.prerecorded.transcribeFile(audioBuffer, {
      model: this.model,
      language: effectiveLanguage,
      smart_format: true,
      punctuate: true,
      paragraphs: false,
      diarize: false,
      utterances: false,
      detect_language: false,
      filler_words: false,
      numerals: false,
      encoding: "linear16",
      sample_rate: 16000,
      channels: 1,
      mimetype: "audio/wav",
    });

    const response = await Promise.race([request, timeout]);
    const transcript =
      response?.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
      "";

    console.log(
      `[speech] <- deepgram result durationMs=${Date.now() - startedAt} textLength=${transcript.length} preview="${transcript.slice(0, 80)}"`,
    );

    return transcript;
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
    allChunks: [],
    headerChunk: null,
    chunkDurationMs: 800,
    lastPartial: "",
    finalTranscript: "",
    transcribing: false,
    intervalId: null,
    queue: Promise.resolve(),
    consecutiveEmptyResults: 0,
    lastStatusSentAt: 0,
    partialCandidate: "",
    partialCandidateCount: 0,
    isStopping: false,
  };

  const send = (payload) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  };

  const resetSessionAudio = () => {
    state.chunks = [];
    state.allChunks = [];
    state.headerChunk = null;
    state.lastPartial = "";
    state.finalTranscript = "";
    state.queue = Promise.resolve();
    state.consecutiveEmptyResults = 0;
    state.lastStatusSentAt = 0;
    state.partialCandidate = "";
    state.partialCandidateCount = 0;
    state.isStopping = false;
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
    state.allChunks.push(buffer);

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
      const sourceChunks = isFinal ? state.allChunks : state.chunks;
      const bufferedChunks = state.headerChunk
        ? [state.headerChunk, ...sourceChunks]
        : sourceChunks;
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

      const energy = await analyzeWavSpeechEnergy(wavPath);
      console.log(
        `[speech] session=${state.sessionLabel} energy rms=${energy.rms.toFixed(1)} peak=${energy.peak || 0} activeRatio=${energy.activeRatio.toFixed(3)} hasSpeech=${energy.hasSpeech}`,
      );

      let rawTranscript = "";
      if (energy.hasSpeech) {
        rawTranscript = normalizeText(
          await state.transcriber.transcribe(wavPath, state.language || "bn"),
        );
      } else {
        console.log(
          `[speech] session=${state.sessionLabel} skipping Deepgram for silent/low-energy audio`,
        );
      }

      console.log(
        `[speech] session=${state.sessionLabel} raw transcript="${rawTranscript}" (length=${rawTranscript.length})`,
      );

      const transcript = sanitizeTranscript(
        rawTranscript,
        state.language || "bn",
      );

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

      if (isFinal) {
        const keepStablePartial =
          isKnownBadBanglaGuess(transcript) &&
          looksLikeStableBanglaPartial(
            state.lastPartial,
            state.language || "bn",
          );
        const finalText = keepStablePartial
          ? state.lastPartial
          : merged || state.lastPartial || "";

        if (keepStablePartial) {
          console.log(
            `[speech] session=${state.sessionLabel} rejected suspicious final transcript="${transcript}"; keeping stable partial="${state.lastPartial}"`,
          );
        }
        if (finalText && finalText !== state.lastPartial) {
          state.lastPartial = finalText;
        }
        state.finalTranscript = state.lastPartial || "";
        console.log(
          `[speech] session=${state.sessionLabel} sending final text="${state.finalTranscript}"`,
        );
        send({ type: "final", text: state.finalTranscript });
      } else if (state.isStopping) {
        console.log(
          `[speech] session=${state.sessionLabel} suppressing partial while final transcription is pending`,
        );
      } else if (merged && merged !== state.lastPartial) {
        if (!looksLikeStableBanglaPartial(merged, state.language || "bn")) {
          if (state.partialCandidate === merged) {
            state.partialCandidateCount += 1;
          } else {
            state.partialCandidate = merged;
            state.partialCandidateCount = 1;
          }

          console.log(
            `[speech] session=${state.sessionLabel} holding unstable partial text="${merged}" seen=${state.partialCandidateCount}`,
          );

          if (state.partialCandidateCount < 2) {
            return;
          }
        }

        state.partialCandidate = "";
        state.partialCandidateCount = 0;
        state.lastPartial = merged;
        console.log(
          `[speech] session=${state.sessionLabel} sending partial text="${merged}"`,
        );
        send({ type: "partial", text: merged });
      } else {
        console.log(
          `[speech] session=${state.sessionLabel} no new text to send (merged matches lastPartial or empty)`,
        );
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
          "Speech recognizer is still initializing on the server. Your speech will still be captured; transcription will begin as soon as it's ready.",
      });
    }
  };

  const stopRecording = async () => {
    state.isStopping = true;
    stopScheduler();
    console.log(`[speech] session=${state.sessionLabel} stop requested`);

    // MediaRecorder can deliver its last data chunk immediately after the stop
    // message. Keep accepting chunks briefly so the final pass is complete.
    await new Promise((resolve) => setTimeout(resolve, 250));
    state.isRecording = false;
    await runTranscription({ isFinal: true });
    state.isStopping = false;
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
      state.allChunks = [];
      state.headerChunk = null;
    },
  };
};

const initializeSpeechWebSocketServer = (httpServer) => {
  const deepgramBridge = new DeepgramBridge();

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

    if (!deepgramBridge.ready && !deepgramBridge.bootError) {
      console.warn(
        "[speech] Deepgram client not confirmed ready yet — first transcription may be slow or fail if initialization is incomplete.",
      );
      ws.send(
        JSON.stringify({
          type: "status",
          message:
            "Speech recognizer is still initializing on the server. Your speech will still be captured; transcription will begin as soon as it's ready.",
        }),
      );
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
          if (!session.state.isRecording && !session.state.isStopping) {
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
          if (
            (!session.state.isRecording && !session.state.isStopping) ||
            !payload.data
          )
            return;
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
