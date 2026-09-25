/**
 * Simulates a speech session with stubbed Deepgram / Gemini / ffmpeg so the
 * server-side pause detection can be checked without API keys:
 *   node --test speech/speechWsServer.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("module");
const EventEmitter = require("events");

const geminiRequests = [];
let deepgramAvailable = true;
let lastDeepgram = null;

const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === "jsonwebtoken") return { verify: () => ({}) };
  if (request === "@ffmpeg-installer/ffmpeg") return { path: "ffmpeg" };
  if (request === "ws") {
    return { WebSocketServer: class extends EventEmitter {} };
  }
  if (request === "@deepgram/sdk") {
    return {
      LiveTranscriptionEvents: {},
      createClient: () => ({
        listen: {
          live: () => {
            if (!deepgramAvailable) throw new Error("Deepgram unavailable");
            const connection = new EventEmitter();
            connection.send = () => {};
            connection.finalize = () => {};
            connection.requestClose = () => {};
            lastDeepgram = connection;
            return connection;
          },
        },
      }),
    };
  }
  if (request === "axios") {
    return {
      post: async (url, body) => {
        geminiRequests.push(body);
        return {
          status: 200,
          data: {
            candidates: [{ content: { parts: [{ text: "রহিমকে কল করো" }] } }],
          },
        };
      },
    };
  }
  if (request.endsWith("aiSettingsStore")) {
    return { getProviderKey: async () => "test-key" };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

delete process.env.JWT_SECRET_KEY;
process.env.DEEPGRAM_API_KEY = "test";
const { initializeSpeechWebSocketServer } = require("./speechWsServer");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 16 kHz mono PCM tone; amplitude 80 ≈ room noise, 4000 ≈ speech. */
const pcm = (amplitude, ms) => {
  const samples = 16 * ms;
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(amplitude * Math.sin(i / 3)), i * 2);
  }
  return buffer;
};

const openSession = async () => {
  const server = initializeSpeechWebSocketServer(new EventEmitter());
  const sent = [];
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = (message) => sent.push(JSON.parse(message));
  ws.close = () => {};
  await sleep(20); // Gemini key cache warm-up.
  server.emit("connection", ws, { url: "/ws/speech", headers: {}, socket: {} });
  const message = (payload) =>
    ws.emit("message", Buffer.from(JSON.stringify(payload)), false);
  const audio = (amplitude, ms) => {
    for (let t = 0; t < ms; t += 64) ws.emit("message", pcm(amplitude, 64), true);
  };
  message({
    type: "start",
    language: "auto",
    mimeType: "audio/l16",
    encoding: "linear16",
    sampleRate: 16000,
  });
  return { sent, message, audio };
};

test("a pause sends the sentence to Gemini even when Deepgram heard nothing", async () => {
  geminiRequests.length = 0;
  deepgramAvailable = true;
  const { sent, message, audio } = await openSession();
  assert.equal(sent[0].type, "ready");
  assert.equal(sent[0].mode, "deepgram");

  audio(80, 640);
  audio(4000, 1280);
  audio(80, 1024);
  await sleep(30);

  // Deepgram's late words for the same sentence must not become a 2nd final.
  lastDeepgram.emit("Results", {
    is_final: true,
    channel: { alternatives: [{ transcript: "কল করো", confidence: 0.4 }] },
  });
  lastDeepgram.emit("UtteranceEnd");
  message({ type: "stop" });
  await sleep(700);

  const finals = sent.filter((item) => item.type === "final");
  assert.equal(geminiRequests.length, 1);
  assert.equal(finals[0].text, "রহিমকে কল করো");
  assert.equal(finals.length, 2);
  assert.equal(finals[1].text, "");
  assert.equal(finals[1].done, true);
  assert.equal(sent.filter((item) => item.type === "partial").length, 0);
});

test("without Deepgram, Gemini alone transcribes each sentence", async () => {
  geminiRequests.length = 0;
  deepgramAvailable = false;
  const { sent, message, audio } = await openSession();
  assert.equal(sent[0].mode, "gemini");

  audio(4000, 1280);
  audio(80, 1024);
  message({ type: "stop" });
  await sleep(700);

  const finals = sent.filter((item) => item.type === "final");
  assert.equal(geminiRequests.length, 1);
  assert.equal(finals[0].text, "রহিমকে কল করো");
  assert.equal(finals.at(-1).done, true);
});
