# Local Bangla Whisper Speech Streaming

This folder contains a WebSocket speech pipeline for real-time Bangla ASR:

- `speechWsServer.js` – Node.js WebSocket server (`/ws/speech`) attached to the main HTTP server.
- `whisperWorker.py` – persistent Python worker using `faster-whisper`.

## Runtime dependencies

### Node.js (already in `server/package.json`)

```bash
cd server
npm install ws
```

### Python

```bash
python -m pip install faster-whisper
```

If your default Python binary is not `python`, set:

```bash
WHISPER_PYTHON_BIN=python3
```

## Optional environment variables

```bash
WHISPER_MODEL_SIZE=base
WHISPER_COMPUTE_TYPE=int8
WHISPER_DEVICE=auto
WHISPER_LANGUAGE=bn
WHISPER_INITIAL_PROMPT=এই অডিওটি বাংলায় বলা হয়েছে। বাংলা ইউনিকোড টেক্সটে সঠিকভাবে লিখুন।
SPEECH_TRANSCRIBE_INTERVAL_MS=1200
SPEECH_MAX_WINDOW_MS=16000
SPEECH_MAX_CHUNKS=24
```

Recommended model order for Bangla quality vs memory:

```bash
# lowest memory
WHISPER_MODEL_SIZE=tiny

# balanced (recommended start)
WHISPER_MODEL_SIZE=base

# better Bangla quality, more RAM/CPU
WHISPER_MODEL_SIZE=small
# or
WHISPER_MODEL_SIZE=medium
```

## WebSocket protocol

Client → Server:

```json
{
  "type": "start",
  "language": "bn",
  "mimeType": "audio/webm;codecs=opus",
  "chunkDurationMs": 800
}
```

Then stream binary audio chunks (MediaRecorder chunks).

To stop:

```json
{ "type": "stop" }
```

Server → Client:

```json
{ "type": "partial", "text": "আমি আজকে" }
```

```json
{ "type": "final", "text": "আমি আজকে ঢাকায় যাব" }
```

```json
{ "type": "error", "message": "..." }
```
