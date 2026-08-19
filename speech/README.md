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
