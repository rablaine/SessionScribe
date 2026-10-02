# YAMNet laughter detector

This directory is the portable audio-event worker boundary used by the Node application. The
detector accepts a local recording path and emits one JSON document to standard output. Local
development and a future Azure Container Apps Job use the same command.

## Runtime

- Python 3.11
- FFmpeg on `PATH`, or supplied with `--ffmpeg`
- dependencies from `requirements.txt`
- official [YAMNet 1](https://tfhub.dev/google/yamnet/1) SavedModel

The model is downloaded from TensorFlow Hub by `download_model.py`. The downloader verifies the
pinned archive SHA-256 before installing it under `detector/models/yamnet`. Model files are not
committed.

YAMNet is provided under Apache License 2.0. TensorFlow is provided under Apache License 2.0.

## Local setup on Windows

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r detector\requirements.txt
.\.venv\Scripts\python.exe detector\download_model.py
```

Set `PYTHON_PATH=.\.venv\Scripts\python.exe` in `.env`.

## Command contract

```powershell
.\.venv\Scripts\python.exe detector\detect_laughter.py `
  --audio .\data\<job-id>\original.mp3 `
  --model .\detector\models\yamnet `
  --duration-ms 240088 `
  --ffmpeg ffmpeg
```

Successful output has schema version 1:

```json
{
  "schemaVersion": 1,
  "model": "yamnet",
  "modelVersion": "1",
  "profileVersion": "yamnet-laughter-v1",
  "events": [
    {
      "id": "L00001",
      "startMs": 89760,
      "endMs": 92160,
      "peakMs": 90720,
      "peakConfidence": 0.217634,
      "meanConfidence": 0.142532,
      "labels": [
        { "name": "Laughter", "peakConfidence": 0.282938 }
      ]
    }
  ]
}
```

Diagnostics go to standard error and a failure returns a nonzero exit code. The Node boundary
validates the complete result before persisting it.

Audio is decoded as streaming mono 16 kHz float PCM. Inference uses bounded batches and does not
load a multi-hour recording into memory. The worker image should install requirements and the
model at image-build time, not when a Container Apps Job starts.

For Azure Container Apps Jobs, the durable worker remains responsible for downloading the private
recording to its ephemeral filesystem before invoking this command and for persisting the returned
JSON before the execution exits. The web App Service must not try to `spawn` a process in a separate
Container Apps Job. The detector deliberately has no Blob credentials or queue semantics; those
stay in the surrounding durable worker.

## Tests

```powershell
$env:PYTHONPATH = "detector"
.\.venv\Scripts\python.exe -m unittest discover -s detector -p "test_*.py"
```
