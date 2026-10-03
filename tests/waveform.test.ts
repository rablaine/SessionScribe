import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
import { runTool } from "../src/audio.js";
import { createDemo } from "../src/demo.js";
import { createSessionFixture } from "./session-fixture.js";
import { waveformWindow } from "../src/waveform.js";

test("waveform windows preserve quiet bins, bounded output and global amplitude scale", () => {
  const peaks = Buffer.alloc(600);
  for (let index = 0; index < 300; index++) peaks.writeUInt16LE(index < 100 || index >= 200 ? 16384 : 0, index * 2);
  const full = waveformWindow(peaks, 0, 3000, 300);
  assert.equal(full.resolutionMs, 10);
  assert.equal(full.maxAmplitude, 0.5);
  assert.equal(full.peaks.length, 300);
  assert(full.peaks.slice(100, 200).every(value => value === 0));
  assert(waveformWindow(peaks, 1200, 1800, 1024).peaks.every(value => value === 0));
  assert(waveformWindow(peaks, 0, 3000, 32).peaks.every(value => value >= 0 && value <= 1));
  assert.throws(() => waveformWindow(Buffer.alloc(3), 0, 3000, 32), /cache is invalid/);
});

test("real MP3/Opus waveforms expose silence without cancelling opposite stereo channels and reuse durable caches", async () => {
  const f = await createSessionFixture("scribe-waveform-");
  try {
    for (const extension of ["mp3", "opus"]) {
      const job = await f.save({ ...createDemo(), demo: false, audioRetained: true,
        originalName: `test.${extension}`, durationMs: 3000 });
      const signal = "if(between(t\\,1\\,2)\\,0\\,0.5*sin(2*PI*440*t))";
      await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
        `aevalsrc=${signal}|-${signal}:s=8000:d=3`, "-codec:a", extension === "mp3" ? "libmp3lame" : "libopus",
        "-f", extension === "mp3" ? "mp3" : "ogg", f.store.audioPath(job.id)], 60000);
      const base = `${f.base}/api/jobs/${job.id}/waveform`;
      const url = `${base}?startMs=0&endMs=3000&bins=300`;
      const responses = await Promise.all([f.request(url), f.request(url)]);
      assert(responses.every(response => response.status === 200));
      const full = await responses[0]!.json();
      assert.equal(full.peaks.length, 300);
      assert(full.maxAmplitude > 0.4, "Opposite-polarity stereo channels must not cancel the waveform.");
      assert(full.peaks.slice(30, 60).every((value: number) => value > 0.3));
      const quiet = await (await f.request(`${base}?startMs=1200&endMs=1800&bins=1024`)).json();
      assert(quiet.peaks.every((value: number) => value < 0.01), "Silence must remain visibly quiet.");
      assert.equal(responses[0]!.headers.get("cache-control"), "no-store");
      const cache = path.join(f.store.directory(job.id), "waveform-v1.bin");
      const bytes = await readFile(cache);
      assert(bytes.length < 1000, "Cache should store peaks, not decoded PCM.");
      const before = (await stat(cache)).mtimeMs;
      assert.equal((await f.request(url)).status, 200);
      assert.equal((await stat(cache)).mtimeMs, before, "Cache should not be regenerated for another viewport.");
      for (const query of ["startMs=-1&endMs=3000", "startMs=0&endMs=3001",
        "startMs=2000&endMs=1000", "startMs=0&endMs=3000&bins=5000"]) {
        assert.equal((await f.request(`${base}?${query}`)).status, 400);
      }
      assert.equal((await fetch(url)).status, 401);
      const unowned = await f.store.save({ ...createDemo(), audioRetained: true });
      assert.equal((await f.request(`${f.base}/api/jobs/${unowned.id}/waveform?startMs=0&endMs=1000`)).status, 404);
      await f.store.save({ ...job, audioRetained: false });
      assert.equal((await f.request(url)).status, 409);
      await f.store.save(job);
      await rm(f.store.audioPath(job.id));
      assert.equal((await f.request(url)).status, 404, "A cache must not bypass a missing original.");
      assert.equal((await f.request(`${f.base}/api/jobs/${job.id}`, { method: "DELETE" })).status, 204);
      await assert.rejects(stat(cache), /ENOENT/);
    }
  } finally { await f.close(); }
});

test("long waveform decodes run in the background: callers get 'not ready' instead of a held request", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const { Waveforms } = await import("../src/waveform.js");
  const directory = await mkdtemp(path.join(os.tmpdir(), "scribe-waveform-bg-"));
  try {
    const input = path.join(directory, "original.mp3");
    await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=20",
      "-codec:a", "libmp3lame", input], 60000);
    const waveforms = new Waveforms(config.ffmpeg);
    assert.equal(await waveforms.window("bg", input, 20_000, 0, 20_000, 64, 0), undefined, "no waiting when asked not to");
    assert.equal(waveforms.isGenerating("bg"), true, "generation continues after the request returns");
    let ready;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) ready = await waveforms.window("bg", input, 20_000, 0, 20_000, 64, 200);
    assert.equal(ready!.peaks.length, 64);
    assert.ok(ready!.maxAmplitude > 0.02, "the decoded tone is audible in the envelope");
    assert.equal(waveforms.isGenerating("bg"), false);
    waveforms.warm("bg", input, 20_000);
    await stat(path.join(directory, "waveform-v1.bin"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});