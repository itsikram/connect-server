# Deepgram Live Bangla Speech Streaming

This folder contains the WebSocket speech pipeline for real-time Bangla speech-to-text:

- `speechWsServer.js` – Node.js WebSocket server (`/ws/speech`) attached to the main HTTP server.
- Browser audio is streamed as `MediaRecorder` chunks to Node.
- Node keeps a single `ffmpeg` process alive per session to convert browser audio into 16 kHz mono PCM.
- PCM is forwarded to a single Deepgram live transcription stream for low-latency partials and fast finalization.

## Runtime dependencies

### Node.js

Already declared in `server/package.json`:

- `@deepgram/sdk`
- `@ffmpeg-installer/ffmpeg`
- `ws`

Install server dependencies as usual:

```bash
cd server
npm install
```

## Required environment variables

```bash
DEEPGRAM_API_KEY=your_key_here
```

## Optional environment variables

```bash
# Global default model (defaults to nova-3)
DEEPGRAM_MODEL=nova-3

# Optional explicit Bangla override if DEEPGRAM_MODEL is set to something else
DEEPGRAM_BANGLA_MODEL=nova-3

# How long the server waits after stop/finalize before flushing the best transcript
SPEECH_FINALIZE_GRACE_MS=1200
```

## Gemini accuracy pass (Bangla + English)

When a Gemini key is configured (Connect Admin → Settings → AI, or `GEMINI_API_KEY`),
every spoken sentence is re-transcribed by Gemini, which is far more accurate than
Deepgram for Bangla, English and mixed speech:

- The server detects the pause after each sentence itself (energy-based VAD), so a
  sentence reaches Gemini even when Deepgram returned no words for it.
- Deepgram partials are only a live preview; the Gemini text is sent as `final`.
- Without `DEEPGRAM_API_KEY` (or if Deepgram fails mid-session) the server runs in
  Gemini-only mode: no live partials, but finals still arrive after each pause.
- `language: "auto"` lets Gemini detect Bangla vs English per sentence.

Optional tuning:

```bash
SPEECH_GEMINI_MODEL=gemini-flash-latest   # model tried first
SPEECH_GEMINI_TIMEOUT_MS=6500             # past this the Deepgram draft is used
SPEECH_VAD_END_SILENCE_MS=850             # pause that ends a sentence
SPEECH_VAD_MIN_SPEECH_MS=160              # sound needed before it counts as speech
SPEECH_VAD_MIN_RMS=420                    # loudness floor for speech (16-bit RMS)
SPEECH_GEMINI_REFINE=false                # disable the Gemini pass
```

`ready` carries `refine` and `mode` (`deepgram` or `gemini`). A `final` with
`empty: true` means no speech was heard (clients must not fall back to the live
preview), and `done: true` marks the last final after a `stop`.

Run the session simulation with `node --test speech/speechWsServer.test.js`.

## Why `nova-3`

Deepgram supports Bengali (`bn`) on `nova-3`.

If `DEEPGRAM_MODEL` is set to `nova-2`, the server automatically overrides Bangla sessions to `DEEPGRAM_BANGLA_MODEL` because `nova-2` does not support Bengali.

## Client protocol

Client → Server:

```json
{
  "type": "start",
  "language": "bn",
  "mimeType": "audio/webm;codecs=opus",
  "chunkDurationMs": 400
}
```

Then stream binary audio chunks from `MediaRecorder`.

To stop:

```json
{ "type": "stop" }
```

Server → Client:

```json
{ "type": "ready", "message": "Speech stream started" }
```

```json
{ "type": "partial", "text": "আমি এখন কথা বলছি" }
```

```json
{ "type": "final", "text": "আমি এখন কথা বলছি" }
```

```json
{ "type": "status", "message": "..." }
```

```json
{ "type": "error", "message": "..." }
```

## Notes

- Partials are emitted during the session and should appear directly in the chat input.
- Final is emitted once the user stops recording and Deepgram flushes the tail of the stream.
- This design is much faster than repeatedly writing temp files and re-transcribing rolling windows.
