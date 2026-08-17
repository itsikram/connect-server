#!/usr/bin/env python3
import json
import os
import sys
import traceback
from typing import Any

# On Windows, stdio defaults to the system codepage (e.g. cp1252), which
# cannot encode Bangla Unicode text and crashes the worker with
# UnicodeEncodeError as soon as a result contains non-Latin characters.
# Force UTF-8 on stdin/stdout/stderr so Bangla (and any other script) is
# always safe to read/write regardless of OS locale.
for _stream_name in ("stdin", "stdout", "stderr"):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover
            pass

try:
    from faster_whisper import WhisperModel
except Exception as exc:  # pragma: no cover
    sys.stderr.write(f"[whisper-worker] Failed to import faster_whisper: {exc}\n")
    sys.stderr.flush()
    raise


MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
DEFAULT_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "bn")
DEFAULT_INITIAL_PROMPT = os.environ.get("WHISPER_INITIAL_PROMPT", "").strip()


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


def build_model() -> WhisperModel:
    log(
        f"[whisper-worker] Loading model size={MODEL_SIZE} device={DEVICE} "
        f"compute_type={COMPUTE_TYPE} default_language={DEFAULT_LANGUAGE}"
    )
    model = WhisperModel(
        MODEL_SIZE,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
    )
    log("[whisper-worker] Model loaded successfully")
    return model


def transcribe_audio(
    model: WhisperModel, audio_path: str, language: str = DEFAULT_LANGUAGE
) -> str:
    try:
        audio_size = os.path.getsize(audio_path)
    except OSError:
        audio_size = -1

    log(
        f"[whisper-worker] Transcribing audio_path={audio_path} "
        f"size_bytes={audio_size} language={language or DEFAULT_LANGUAGE}"
    )

    transcribe_kwargs: dict[str, Any] = {
        "language": language or DEFAULT_LANGUAGE,
        "task": "transcribe",
        "beam_size": 1,
        "best_of": 1,
        "temperature": 0.0,
        "vad_filter": True,
        "vad_parameters": {
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 200,
        },
        "condition_on_previous_text": False,
        "word_timestamps": False,
        "no_speech_threshold": 0.6,
        "log_prob_threshold": -1.0,
        "compression_ratio_threshold": 2.4,
        "hallucination_silence_threshold": 0.35,
    }

    if DEFAULT_INITIAL_PROMPT:
        transcribe_kwargs["initial_prompt"] = DEFAULT_INITIAL_PROMPT

    segments, info = model.transcribe(
        audio_path,
        **transcribe_kwargs,
    )

    text_parts = []
    segment_count = 0
    for seg in segments:
        segment_count += 1
        part = (seg.text or "").strip()
        if part:
            text_parts.append(part)

    result_text = " ".join(text_parts).strip()

    log(
        f"[whisper-worker] Result detected_language={info.language} "
        f"language_probability={info.language_probability:.3f} "
        f"segment_count={segment_count} text_length={len(result_text)} "
        f"text_preview={result_text[:120]!r}"
    )

    return result_text


def main() -> None:
    model = build_model()

    emit(
        {
            "type": "ready",
            "model": MODEL_SIZE,
            "device": DEVICE,
            "compute_type": COMPUTE_TYPE,
            "language": DEFAULT_LANGUAGE,
        }
    )

    log("[whisper-worker] Waiting for transcription requests on stdin...")

    for raw_line in sys.stdin:
        line = (raw_line or "").strip()
        if not line:
            continue

        payload = None

        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            command = payload.get("type", "transcribe")

            if command == "shutdown":
                emit({"type": "bye", "id": request_id})
                break

            if command != "transcribe":
                emit(
                    {
                        "type": "error",
                        "id": request_id,
                        "message": f"Unsupported command: {command}",
                    }
                )
                continue

            audio_path = payload.get("audioPath")
            language = payload.get("language", DEFAULT_LANGUAGE)

            if not audio_path:
                emit(
                    {
                        "type": "error",
                        "id": request_id,
                        "message": "Missing audioPath",
                    }
                )
                continue

            text = transcribe_audio(model, audio_path, language)
            emit({"type": "result", "id": request_id, "text": text})
        except Exception as exc:  # pragma: no cover
            log(f"[whisper-worker] ERROR during transcription: {exc}")
            log(traceback.format_exc())
            emit(
                {
                    "type": "error",
                    "id": (payload.get("id") if isinstance(payload, dict) else None),
                    "message": str(exc),
                    "trace": traceback.format_exc(),
                }
            )


if __name__ == "__main__":
    main()
