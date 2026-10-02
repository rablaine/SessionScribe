from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Sequence

import numpy as np
import tensorflow as tf

SAMPLE_RATE = 16_000
PATCH_SAMPLES = 15_600
PATCH_HOP_SAMPLES = 7_680
PATCH_HOP_MS = 480
PATCH_DURATION_MS = 960
BATCH_PATCHES = 256
LAUGHTER_CLASSES = (
    (13, "Laughter"),
    (15, "Giggle"),
    (16, "Snicker"),
    (17, "Belly laugh"),
    (18, "Chuckle, chortle"),
)


def complete_patch_count(sample_count: int) -> int:
    if sample_count < PATCH_SAMPLES:
        return 0
    return 1 + (sample_count - PATCH_SAMPLES) // PATCH_HOP_SAMPLES


@dataclass(frozen=True)
class Profile:
    high_threshold: float
    low_threshold: float
    merge_gap_ms: int
    min_duration_ms: int


def _read_samples(stream: BinaryIO, sample_count: int) -> np.ndarray:
    requested_bytes = sample_count * np.dtype(np.float32).itemsize
    chunks: list[bytes] = []
    received = 0
    while received < requested_bytes:
        chunk = stream.read(requested_bytes - received)
        if not chunk:
            break
        chunks.append(chunk)
        received += len(chunk)
    data = b"".join(chunks)
    aligned_length = len(data) - len(data) % np.dtype(np.float32).itemsize
    return np.frombuffer(data[:aligned_length], dtype="<f4").copy()


def _decode_scores(
    model: object,
    audio_path: Path,
    ffmpeg: str,
) -> tuple[np.ndarray, str]:
    process = subprocess.Popen(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(audio_path),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "f32le",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if process.stdout is None or process.stderr is None:
        process.kill()
        raise RuntimeError("FFmpeg pipes were not created.")

    retained = np.empty(0, dtype=np.float32)
    score_batches: list[np.ndarray] = []
    processed_any = False
    try:
        while True:
            required = PATCH_SAMPLES + (BATCH_PATCHES - 1) * PATCH_HOP_SAMPLES - retained.size
            incoming = _read_samples(process.stdout, max(0, required))
            waveform = np.concatenate((retained, incoming))
            final_batch = incoming.size < required
            if processed_any and waveform.size < PATCH_SAMPLES and not incoming.size:
                # The retained overlap can still produce YAMNet's final padded frame.
                final_batch = True
            if waveform.size < PATCH_SAMPLES:
                if waveform.size:
                    padded = np.pad(waveform, (0, PATCH_SAMPLES - waveform.size))
                    scores, _, _ = model(tf.convert_to_tensor(padded, dtype=tf.float32))
                    score_batches.append(np.asarray(scores)[:, [item[0] for item in LAUGHTER_CLASSES]])
                break

            scores, _, _ = model(tf.convert_to_tensor(waveform, dtype=tf.float32))
            batch = np.asarray(scores)[:, [item[0] for item in LAUGHTER_CLASSES]]
            processed_any = True
            if final_batch:
                score_batches.append(batch)
                break
            complete_patches = complete_patch_count(waveform.size)
            score_batches.append(batch[:complete_patches])
            consumed = complete_patches * PATCH_HOP_SAMPLES
            retained = waveform[consumed:].copy()
    finally:
        process.stdout.close()

    stderr = process.stderr.read().decode("utf-8", errors="replace")[-4000:]
    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(f"FFmpeg audio decoding failed ({return_code}): {stderr.strip()}")
    if not score_batches:
        raise RuntimeError("The recording did not produce any YAMNet analysis frames.")
    return np.concatenate(score_batches, axis=0), stderr


def _smooth(values: np.ndarray) -> np.ndarray:
    if values.size < 3:
        return values.copy()
    padded = np.pad(values, (1, 1), mode="edge")
    return (
        padded[:-2] * np.float32(0.25)
        + padded[1:-1] * np.float32(0.5)
        + padded[2:] * np.float32(0.25)
    )


def build_events(
    class_scores: np.ndarray,
    duration_ms: int,
    profile: Profile,
) -> list[dict[str, object]]:
    if class_scores.ndim != 2 or class_scores.shape[1] != len(LAUGHTER_CLASSES):
        raise ValueError("Expected one score column for each configured laughter class.")
    combined = _smooth(np.max(class_scores, axis=1))
    candidates: list[tuple[int, int]] = []
    index = 0
    while index < combined.size:
        if combined[index] < profile.high_threshold:
            index += 1
            continue
        start = index
        while start > 0 and combined[start - 1] >= profile.low_threshold:
            start -= 1
        end = index + 1
        while end < combined.size and combined[end] >= profile.low_threshold:
            end += 1
        candidates.append((start, end))
        index = end

    merged: list[tuple[int, int]] = []
    for start, end in candidates:
        if merged:
            previous_start, previous_end = merged[-1]
            gap_ms = start * PATCH_HOP_MS - ((previous_end - 1) * PATCH_HOP_MS + PATCH_DURATION_MS)
            if gap_ms <= profile.merge_gap_ms:
                merged[-1] = (previous_start, max(previous_end, end))
                continue
        merged.append((start, end))

    events: list[dict[str, object]] = []
    for start, end in merged:
        start_ms = start * PATCH_HOP_MS
        end_ms = min(duration_ms, (end - 1) * PATCH_HOP_MS + PATCH_DURATION_MS)
        if end_ms - start_ms < profile.min_duration_ms:
            continue
        event_scores = class_scores[start:end]
        combined_scores = combined[start:end]
        peak_offset = int(np.argmax(combined_scores))
        labels = [
            {"name": name, "peakConfidence": round(float(np.max(event_scores[:, column])), 6)}
            for column, (_, name) in enumerate(LAUGHTER_CLASSES)
            if float(np.max(event_scores[:, column])) >= profile.low_threshold
        ]
        events.append(
            {
                "id": f"L{len(events) + 1:05d}",
                "startMs": start_ms,
                "endMs": end_ms,
                "peakMs": min(duration_ms, (start + peak_offset) * PATCH_HOP_MS + PATCH_DURATION_MS // 2),
                "peakConfidence": round(float(np.max(combined_scores)), 6),
                "meanConfidence": round(float(np.mean(combined_scores)), 6),
                "labels": labels,
            }
        )
    return events


def detect(
    audio_path: Path,
    model_path: Path,
    duration_ms: int,
    ffmpeg: str,
    profile: Profile,
) -> dict[str, object]:
    if not audio_path.is_file():
        raise FileNotFoundError(f"Recording not found: {audio_path}")
    if not (model_path / "saved_model.pb").is_file():
        raise FileNotFoundError(
            f"YAMNet model not found at {model_path}. Run detector/download_model.py first."
        )
    model = tf.saved_model.load(str(model_path))
    scores, _ = _decode_scores(model, audio_path, ffmpeg)
    events = build_events(scores, duration_ms, profile)
    return {
        "schemaVersion": 1,
        "model": "yamnet",
        "modelVersion": "1",
        "profileVersion": "yamnet-laughter-v1",
        "events": events,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Detect timestamped laughter with YAMNet.")
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--duration-ms", type=int, required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--high-threshold", type=float, default=0.15)
    parser.add_argument("--low-threshold", type=float, default=0.05)
    parser.add_argument("--merge-gap-ms", type=int, default=720)
    parser.add_argument("--min-duration-ms", type=int, default=720)
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    options = _parser().parse_args(arguments)
    if options.duration_ms <= 0:
        raise ValueError("duration-ms must be positive.")
    if not 0 <= options.low_threshold <= options.high_threshold <= 1:
        raise ValueError("Thresholds must satisfy 0 <= low <= high <= 1.")
    if options.merge_gap_ms < 0 or options.min_duration_ms < 0:
        raise ValueError("Duration settings must be nonnegative.")
    result = detect(
        options.audio.resolve(),
        options.model.resolve(),
        options.duration_ms,
        options.ffmpeg,
        Profile(
            high_threshold=options.high_threshold,
            low_threshold=options.low_threshold,
            merge_gap_ms=options.merge_gap_ms,
            min_duration_ms=options.min_duration_ms,
        ),
    )
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Laughter detection failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
