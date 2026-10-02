import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingFormat, validateRecordingMetadata } from "../src/audio.js";

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
