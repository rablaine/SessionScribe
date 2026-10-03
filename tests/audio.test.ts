import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { extractAudioClip, inspectDecodedDuration, normalizeAudio, recordingFormat, runTool, validateRecordingMetadata } from "../src/audio.js";

test("MP3 duration limit is measured, not inferred from bytes or filename", () => {
  const metadata = {
    format: { duration: 4 * 60 * 60, format_name: "mp3" },
    streams: [{ codec_type: "audio", codec_name: "mp3" }],
  };
  assert.equal(validateRecordingMetadata(metadata, "session.mp3"), 14400000);
  assert.throws(() => validateRecordingMetadata({
    ...metadata, format: { ...metadata.format, duration: 4 * 60 * 60 + 0.01 },
  }, "session.mp3"), /4-hour limit/);
  assert.throws(() => validateRecordingMetadata({
    ...metadata, format: { ...metadata.format, format_name: "wav" },
  }, "session.mp3"), /not a valid MP3/);
});

test("Opus requires a real Ogg Opus stream and preserves the measured duration limit", () => {
  const metadata = {
    format: { duration: 4 * 60 * 60, format_name: "ogg" },
    streams: [{ codec_type: "audio", codec_name: "opus" }],
  };
  for (const name of ["session.opus", "session.OPUS", "session.ogg", "session.OGG"]) {
    assert.equal(recordingFormat(name), "opus");
    assert.equal(validateRecordingMetadata(metadata, name), 14400000);
  }
  assert.throws(() => validateRecordingMetadata({
    ...metadata, streams: [{ codec_type: "audio", codec_name: "vorbis" }],
  }, "session.ogg"), /not a valid Ogg Opus/);
  assert.throws(() => validateRecordingMetadata({
    ...metadata, format: { ...metadata.format, format_name: "webm" },
  }, "session.opus"), /not a valid Ogg Opus/);
  assert.throws(() => validateRecordingMetadata({
    ...metadata, format: { ...metadata.format, duration: 4 * 60 * 60 + 0.01 },
  }, "session.opus"), /4-hour limit/);
  assert.throws(() => validateRecordingMetadata(metadata, "session.mp3"), /not a valid MP3/);
  assert.throws(() => validateRecordingMetadata(metadata, "session.wav"), /Only MP3 and Ogg Opus/);
  assert.equal(recordingFormat("session.opus.exe"), undefined);
});

test("voice leveling works for the Speech copy and for clip exports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "leveling-"));
  try {
    const input = path.join(root, "in.mp3");
    // A quiet tone then a loud one, like a quiet DM followed by a loud player.
    await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
      "sine=frequency=300:duration=4,volume=0.05[a];sine=frequency=500:duration=4[b];[a][b]concat=n=2:v=0:a=1",
      "-ac", "2", "-codec:a", "libmp3lame", input], 30_000);
    const mono = path.join(root, "mono.mp3");
    await normalizeAudio(config.ffmpeg, input, mono, undefined, undefined, true);
    assert(Math.abs(await inspectDecodedDuration(config.ffprobe, mono) - 8000) < 300);
    for (const balanced of [true, false]) {
      const clip = path.join(root, `clip-${balanced}.mp3`);
      await extractAudioClip(config.ffmpeg, input, clip, 1000, 7000, balanced);
      assert(Math.abs(await inspectDecodedDuration(config.ffprobe, clip) - 6000) < 300);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});