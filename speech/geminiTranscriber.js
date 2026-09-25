/**
 * Second-pass speech recognition with Gemini.
 *
 * Deepgram gives fast live partials, but its Bangla (and mixed Bangla/English)
 * accuracy is weak. When an utterance ends, the buffered 16-bit PCM for that
 * utterance is sent to Gemini, which transcribes Bangla, English and Banglish
 * far more accurately. Any failure falls back to the Deepgram text.
 */
const axios = require("axios");
const { getProviderKey } = require("../utils/aiSettingsStore");

const REFINE_ENABLED = process.env.SPEECH_GEMINI_REFINE !== "false";
// Tried in order; a model Google has retired (404) falls through to the next.
// "-latest" aliases keep working as Google rotates model versions.
const MODEL_CHAIN = [
  process.env.SPEECH_GEMINI_MODEL,
  // Measured on Bangla/Banglish/English clips: accurate Bengali script in
  // ~2s. "Lite" models romanize Bangla, so they are deliberately not used.
  "gemini-3.8-flash",
  "gemini-flash-latest",
].filter((value, index, list) => value && list.indexOf(value) === index);
let activeModelIndex = 0;
// Past this, the Deepgram text is used instead so the user is not kept waiting.
const TIMEOUT_MS = Number(process.env.SPEECH_GEMINI_TIMEOUT_MS) || 6500;
const KEY_LOOKUP_TIMEOUT_MS = 1500;
const MIN_SECONDS = 0.35;
const NO_SPEECH = "NO_SPEECH";

const KEY_CACHE_MS = 60 * 1000;
let cachedKeys = { at: 0, keys: [] };

const loadGeminiKeys = async () => {
  if (Date.now() - cachedKeys.at < KEY_CACHE_MS) return cachedKeys.keys;
  let raw = "";
  try {
    // Admin-configured key first; don't let a slow database block speech.
    raw =
      (await Promise.race([
        getProviderKey("gemini"),
        new Promise((resolve) => setTimeout(() => resolve(""), KEY_LOOKUP_TIMEOUT_MS)),
      ])) || "";
  } catch (_) {
    raw = "";
  }
  raw = raw || process.env.GEMINI_API_KEY || "";
  const keys = String(raw)
    .split(/[\s,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  cachedKeys = { at: Date.now(), keys };
  return keys;
};

const isGeminiRefineAvailable = async () =>
  REFINE_ENABLED && (await loadGeminiKeys()).length > 0;

/** Cached, synchronous availability check (refreshes in the background). */
const isGeminiRefineReady = () => {
  loadGeminiKeys().catch(() => {});
  return REFINE_ENABLED && cachedKeys.keys.length > 0;
};
// Warm the key cache at boot so the first session already knows.
loadGeminiKeys().catch(() => {});

const pcmToWav = (pcm, sampleRate = 16000) => {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

/** True when a clip is long and loud enough to be worth transcribing. */
const shouldRefine = (pcm, sampleRate = 16000) =>
  REFINE_ENABLED &&
  Boolean(pcm && pcm.length >= sampleRate * 2 * MIN_SECONDS) &&
  hasAudibleSpeech(pcm);

/** Peak amplitude check so silent clips never reach the API. */
const hasAudibleSpeech = (pcm) => {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 32) {
    const sample = Math.abs(pcm.readInt16LE(i));
    if (sample > peak) peak = sample;
    if (peak > 900) return true;
  }
  return false;
};

const languageLine = (language = "") => {
  const value = String(language).toLowerCase();
  if (value.startsWith("bn")) {
    return "The speaker is most likely speaking Bangla (Bengali), possibly mixed with English words.";
  }
  if (value.startsWith("en")) {
    return "The speaker is most likely speaking English, possibly mixed with Bangla words.";
  }
  return "The speaker may speak Bangla (Bengali), English, or a mix of both.";
};

const buildPrompt = (language, draft) =>
  [
    "Transcribe this short voice command spoken to the Connect social app.",
    languageLine(language),
    "Write Bangla words in Bengali script. Keep English words, people's names and app terms (video call, YouTube, Ludo, post) as they were spoken.",
    "Output ONLY the exact words spoken — no translation, no quotes, no labels, no explanation.",
    `If there is no clear human speech, output ${NO_SPEECH}.`,
    draft
      ? `A faster recognizer heard (may contain mistakes, use only as a hint for names): "${draft}"`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

const cleanTranscript = (text = "") =>
  String(text || "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/^(transcript(ion)?|text)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

const requestGemini = async (model, key, body) =>
  axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(key)}`,
    body,
    { timeout: TIMEOUT_MS, validateStatus: () => true },
  );

const isRetiredModel = (status, data) =>
  status === 404 ||
  /no longer available|not found|is not supported/i.test(
    String(data?.error?.message || ""),
  );

/**
 * Returns Gemini's transcript for a PCM clip, "" when Gemini hears no speech,
 * or null when refinement is unavailable/failed (caller keeps its own text).
 */
const transcribeWithGemini = async (
  pcm,
  { sampleRate = 16000, language = "bn", draft = "", model: forcedModel } = {},
) => {
  if (!REFINE_ENABLED || !pcm || !pcm.length) return null;
  if (pcm.length < sampleRate * 2 * MIN_SECONDS) return null;
  if (!hasAudibleSpeech(pcm)) return null;

  const keys = await loadGeminiKeys();
  if (!keys.length) return null;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "audio/wav",
              data: pcmToWav(pcm, sampleRate).toString("base64"),
            },
          },
          { text: buildPrompt(language, draft) },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      // Headroom for Gemini 3 models, which may think despite budget 0.
      maxOutputTokens: 768,
      // Transcription needs no reasoning; skipping it cuts latency a lot.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const startedAt = Date.now();
  for (const key of keys) {
    try {
      let model = forcedModel || MODEL_CHAIN[activeModelIndex];
      let response = await requestGemini(model, key, body);
      if (response.status === 400 && body.generationConfig.thinkingConfig) {
        delete body.generationConfig.thinkingConfig;
        response = await requestGemini(model, key, body);
      }
      while (
        !forcedModel &&
        isRetiredModel(response.status, response.data) &&
        activeModelIndex < MODEL_CHAIN.length - 1
      ) {
        activeModelIndex += 1;
        model = MODEL_CHAIN[activeModelIndex];
        console.warn(`[speech] Gemini model retired; switching to ${model}`);
        response = await requestGemini(model, key, body);
      }
      if (response.status >= 400) {
        const message = response.data?.error?.message || `HTTP ${response.status}`;
        console.warn(`[speech] Gemini transcription failed: ${message}`);
        // Quota/rate limits: try the next key. Anything else: give up.
        if ([429, 500, 502, 503, 504].includes(response.status)) continue;
        return null;
      }
      const text = cleanTranscript(
        (response.data?.candidates?.[0]?.content?.parts || [])
          .map((part) => part?.text || "")
          .join(""),
      );
      console.log(
        `[speech] Gemini transcript (${Date.now() - startedAt}ms) "${text}"`,
      );
      if (!text || text.toUpperCase().includes(NO_SPEECH)) return "";
      return text;
    } catch (error) {
      console.warn(`[speech] Gemini transcription error: ${error.message}`);
      return null;
    }
  }
  return null;
};

module.exports = {
  transcribeWithGemini,
  isGeminiRefineAvailable,
  isGeminiRefineReady,
  shouldRefine,
  pcmToWav,
};
