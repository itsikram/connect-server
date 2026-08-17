#!/usr/bin/env python3
import audioop
import json
import os
import re
import sys
import traceback
import wave
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
DEFAULT_INITIAL_PROMPT = os.environ.get(
    "WHISPER_INITIAL_PROMPT",
    "এই অডিওটি বাংলায় বলা হয়েছে। বাংলা ইউনিকোড টেক্সটে সঠিকভাবে লিখুন।",
).strip()

BENGALI_CHAR_REGEX = r"[\u0980-\u09FF]"
TIBETAN_CHAR_REGEX = r"[\u0F00-\u0FFF]"
MIN_RMS_ENERGY = int(os.environ.get("SPEECH_MIN_RMS", "220"))


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


def _has_repeating_pattern(text: str) -> bool:
    compact = re.sub(r"\s+", "", text or "")
    if len(compact) < 12:
        return False

    for size in range(1, 7):
        seed = compact[:size]
        if not seed:
            continue

        matched = 0
        for i in range(0, len(compact), size):
            part = compact[i : i + size]
            if not part:
                continue
            if seed.startswith(part) or part == seed:
                matched += len(part)

        if matched / max(1, len(compact)) >= 0.82:
            return True

    return False


def _is_low_energy_audio(audio_path: str) -> bool:
    try:
        with wave.open(audio_path, "rb") as wf:
            frame_count = wf.getnframes()
            if frame_count <= 0:
                return True

            frames = wf.readframes(frame_count)
            sample_width = wf.getsampwidth()
            if not frames or sample_width <= 0:
                return True

            rms = audioop.rms(frames, sample_width)
            log(
                f"[whisper-worker] Audio energy check rms={rms} threshold={MIN_RMS_ENERGY}"
            )
            return rms < MIN_RMS_ENERGY
    except Exception as exc:
        log(f"[whisper-worker] Audio energy check failed: {exc}")
        return False


def _is_low_quality_text(text: str, language: str | None) -> bool:
    value = (text or "").strip()
    if not value:
        return True

    if re.search(TIBETAN_CHAR_REGEX, value):
        return True

    words = [w for w in value.split(" ") if w]
    if len(words) >= 6 and len(set(words)) <= 2:
        return True

    compact = re.sub(r"\s+", "", value)
    if len(compact) >= 12 and len(set(compact)) <= 2:
        return True

    if _has_repeating_pattern(value):
        return True

    if " " not in value and len(compact) >= 24 and len(set(compact)) <= 6:
        return True

    # In Bangla mode, require at least some Bangla characters for longer text,
    # otherwise it's usually hallucinated symbols/noise.
    if (language or "").lower().startswith("bn") and len(value) >= 8:
        if not re.search(BENGALI_CHAR_REGEX, value):
            latin_ratio = len(re.findall(r"[A-Za-z]", value)) / max(1, len(value))
            if latin_ratio < 0.5:
                return True

    return False


def _transcribe_once(
    model: WhisperModel,
    audio_path: str,
    language: str | None,
    initial_prompt: str | None,
) -> tuple[str, Any]:
    transcribe_kwargs: dict[str, Any] = {
        "language": language,
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

    if initial_prompt:
        transcribe_kwargs["initial_prompt"] = initial_prompt

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
        f"[whisper-worker] Pass result language={language or 'auto'} detected_language={info.language} "
        f"language_probability={info.language_probability:.3f} segment_count={segment_count} "
        f"text_length={len(result_text)} text_preview={result_text[:120]!r}"
    )

    return result_text, info


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

    if _is_low_energy_audio(audio_path):
        log("[whisper-worker] Skipping transcription for low-energy window")
        return ""

    primary_language = language or DEFAULT_LANGUAGE
    result_text, info = _transcribe_once(
        model,
        audio_path,
        primary_language,
        DEFAULT_INITIAL_PROMPT,
    )

    if _is_low_quality_text(result_text, primary_language):
        log(
            "[whisper-worker] Primary pass low quality; retrying with auto-language and no prompt"
        )
        retry_text, retry_info = _transcribe_once(
            model,
            audio_path,
            None,
            None,
        )
        if not _is_low_quality_text(retry_text, None):
            result_text = retry_text
            info = retry_info

    log(
        f"[whisper-worker] Result selected detected_language={info.language} "
        f"language_probability={info.language_probability:.3f} "
        f"text_length={len(result_text)} text_preview={result_text[:120]!r}"
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
