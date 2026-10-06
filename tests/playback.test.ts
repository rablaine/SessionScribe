import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
import { extractAudioClip, inspectDecodedDuration, normalizeAudio, runTool } from "../src/audio.js";
import { MAX_PLAYBACK_BYTES, PlaybackAudio, validatePlaybackSize } from "../src/playback.js";
import { createDemo } from "../src/demo.js";
import { createSessionFixture } from "./session-fixture.js";
import { JobStore } from "../src/store.js";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function createUnindexedMp3(file: string) {
  const expression = "if(lt(t\\,60)\\,0.001*sin(2*PI*220*t)\\,if(between(t\\,80\\,86)\\,0.3*sin(2*PI*880*t)\\,0.2*(2*random(0)-1)))";
  await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
    `aevalsrc=${expression}:s=44100:d=120`, "-codec:a", "libmp3lame", "-q:a", "4", "-write_xing", "0", file], 60000);
}

async function decode(file: string, output: string, sampleRate = 16000) {
  await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-y", "-i", file,
    "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", output], 60000);
  return readFile(output);
}

function frequency(pcm: Buffer, startSeconds = 1) {
  const from = startSeconds * 32000;
  assert(pcm.length >= from + 32000, "The decoded audio contains the requested one-second window.");
  let crossings = 0;
  for (let offset = from; offset < from + 32000; offset += 2) {
    if (pcm.readInt16LE(offset - 2) <= 0 && pcm.readInt16LE(offset) > 0) crossings++;
  }
  return crossings;
}

test("CBR playback preserves marker times, replaces lossless caches, and never changes the original", async () => {
  const f = await createSessionFixture("scribe-playback-media-");
  try {
    const job = await f.save({ ...createDemo(), demo: false, audioRetained: true, originalName: "unindexed.mp3", durationMs: 120000 });
    const original = f.store.audioPath(job.id);
    const indexed = f.store.playbackPath(job.id);
    await createUnindexedMp3(original);
    const originalBytes = await readFile(original);
    const stale = `${indexed}.00000000-0000-0000-0000-000000000001.tmp`;
    const legacy = path.join(f.store.directory(job.id), "playback-v1.mp3");
    const legacyTemporary = `${legacy}.00000000-0000-0000-0000-000000000002.tmp`;
    await writeFile(legacy, "old-lossless-cache");
    await writeFile(legacyTemporary, "interrupted-remux");
    await writeFile(path.join(f.store.directory(job.id), "unrelated.tmp"), "keep");
    await writeFile(stale, "interrupted-copy");
    const originalDuration = await inspectDecodedDuration(config.ffprobe, original);
    assert(Math.abs(originalDuration - 120000) > 1000, "Fixture must reproduce unreliable header-based timing.");
    const playback = new PlaybackAudio(config.ffmpeg);
    const results = await Promise.all(Array.from({ length: 3 }, () => playback.prepare(job.id, original, indexed, 60000)));
    assert(results.every(Boolean), "Concurrent playback requests join the same encoder.");
    assert.equal(playback.isGenerating(job.id), false);
    await assert.rejects(stat(stale), { code: "ENOENT" });
    await assert.rejects(stat(legacy), { code: "ENOENT" });
    await assert.rejects(stat(legacyTemporary), { code: "ENOENT" });
    assert.equal(await readFile(path.join(f.store.directory(job.id), "unrelated.tmp"), "utf8"), "keep");
    assert.equal(hash(await readFile(original)), hash(originalBytes));
    assert(Math.abs(await inspectDecodedDuration(config.ffprobe, indexed) - 120000) < 100);
    const originalPcm = await decode(original, path.join(f.root, "original.pcm"), 44100);
    const indexedPcm = await decode(indexed, path.join(f.root, "indexed.pcm"), 44100);
    const decoderDelaySamples = (originalPcm.length - indexedPcm.length) / 2;
    assert(decoderDelaySamples >= 0 && decoderDelaySamples <= 44100 * 0.02,
      "Only the MP3 decoder's sub-20 ms gapless delay may differ; no accumulated drift is allowed.");
    const packets = JSON.parse(await runTool(config.ffprobe, ["-v", "error", "-select_streams", "a:0",
      "-show_entries", "packet=size", "-of", "json", indexed], 60000)) as { packets: { size: string }[] };
    const sizes = new Set(packets.packets.map(packet => Number(packet.size)));
    assert(sizes.size <= 2 && [...sizes].every(size => size === 626 || size === 627),
      "Every MP3 frame must be 192 kbps CBR (only the one-byte padding may vary).");
    for (const seconds of [20, 65, 82, 110]) {
      const from = seconds * 44100 * 2;
      let dot = 0, sourcePower = 0, playbackPower = 0;
      for (let offset = 0; offset < 44100 * 2; offset += 2) {
        const a = originalPcm.readInt16LE(from + decoderDelaySamples * 2 + offset);
        const b = indexedPcm.readInt16LE(from + offset);
        dot += a * b; sourcePower += a * a; playbackPower += b * b;
      }
      assert(dot / Math.sqrt(sourcePower * playbackPower) > 0.9,
        "Re-encoded samples remain aligned early and late; no leveling or accumulated drift.");
    }
    const before = (await stat(indexed)).mtimeMs;
    assert.equal(await playback.prepare(job.id, original, indexed, 60000), true);
    assert.equal((await stat(indexed)).mtimeMs, before, "Reuse the completed CBR cache.");

    const mono = path.join(f.root, "speech.mp3");
    await normalizeAudio(config.ffmpeg, original, mono, undefined, undefined, true);
    for (const source of [original, indexed, mono]) {
      const clip = path.join(f.root, `marker-${path.basename(source)}.mp3`);
      await extractAudioClip(config.ffmpeg, source, clip, 81000, 84000, false);
      const pcm = await decode(clip, `${clip}.pcm`);
      assert(Math.abs(frequency(pcm) - 880) < 20, "Playback, Speech leveling, and export must use the same marker time.");
    }
  } finally { await f.close(); }
});

test("playback repair is opt-in, owned, persisted, asynchronous, range-capable, and keeps original downloads", async () => {
  const f = await createSessionFixture("scribe-playback-api-");
  try {
    const job = await f.save({ ...createDemo(), demo: false, audioRetained: true, originalName: "test.mp3", durationMs: 120000 });
    await createUnindexedMp3(f.store.audioPath(job.id));
    const endpoint = `${f.base}/api/jobs/${job.id}/playback`;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    const unowned = await f.store.save({ ...createDemo(), audioRetained: true });
    assert.equal((await f.request(`${f.base}/api/jobs/${unowned.id}/playback`)).status, 404);
    assert.equal((await f.request(`${f.base}/api/jobs/${unowned.id}/playback`, { method: "POST" })).status, 404);
    const unauthorizedPost = await fetch(endpoint, { method: "POST", headers: { Cookie: f.credentials.cookie } });
    assert.equal(unauthorizedPost.status, 403);
    await writeFile(path.join(f.store.directory(job.id), "playback-v1.mp3"), "old-lossless-copy");
    for (let visit = 0; visit < 2; visit++) {
      const normal = await f.request(endpoint);
      assert.deepEqual(await normal.json(), { status: "ready", url: `/api/jobs/${job.id}/audio` });
      assert.equal(f.store.get(job.id)!.playbackRepairRequested, undefined);
      await assert.rejects(stat(f.store.playbackPath(job.id)), { code: "ENOENT" });
    }
    assert.equal((await f.request(`${f.base}/api/jobs/${job.id}/audio?playback=2`)).status, 409);
    const legacyBeforeRepair = await f.request(`${f.base}/api/jobs/${job.id}/audio?indexed=1`);
    assert.equal(hash(Buffer.from(await legacyBeforeRepair.arrayBuffer())), hash(await readFile(f.store.audioPath(job.id))),
      "An old player URL must not opt a session into encoding.");
    await assert.rejects(stat(f.store.playbackPath(job.id)), { code: "ENOENT" });
    let response = await f.request(endpoint, { method: "POST" });
    const deadline = Date.now() + 10000;
    while (response.status === 202 && Date.now() < deadline) {
      assert.equal((await response.json()).status, "generating");
      assert.equal(response.headers.get("retry-after"), "3");
      await new Promise(resolve => setTimeout(resolve, 20));
      response = await f.request(endpoint);
    }
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "ready");
    assert.equal(result.url, `/api/jobs/${job.id}/audio?playback=2`);
    assert.equal(f.store.get(job.id)!.playbackRepairRequested, true);
    const persisted = JSON.parse(await readFile(path.join(f.store.directory(job.id), "job.json"), "utf8"));
    assert.equal(persisted.playbackRepairRequested, true, "Opt-in survives restarts.");
    const restarted = new JobStore(f.root);
    await restarted.init();
    assert.equal(restarted.get(job.id)!.playbackRepairRequested, true);
    const legacyPlayer = await f.request(`${f.base}/api/jobs/${job.id}/audio?indexed=1`, { headers: { Range: "bytes=50-99" } });
    assert.equal(legacyPlayer.status, 206, "Already-open players also receive the corrected CBR copy.");
    const partial = await f.request(`${f.base}${result.url}`, { headers: { Range: "bytes=50-99" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-type"), "audio/mpeg");
    assert.equal(partial.headers.get("cache-control"), "no-store");
    const cache = await readFile(f.store.playbackPath(job.id));
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), cache.subarray(50, 100));
    assert.deepEqual(Buffer.from(await legacyPlayer.arrayBuffer()), cache.subarray(50, 100));
    const modified = (await stat(f.store.playbackPath(job.id))).mtimeMs;
    assert.deepEqual(await (await f.request(endpoint)).json(), result);
    assert.deepEqual(await (await f.request(endpoint, { method: "POST" })).json(), result);
    assert.equal((await stat(f.store.playbackPath(job.id))).mtimeMs, modified, "Future visits and repair clicks reuse the cache.");
    const download = await f.request(`${f.base}${result.url}&download=1`);
    assert.equal(download.status, 200);
    assert.equal(hash(Buffer.from(await download.arrayBuffer())), hash(await readFile(f.store.audioPath(job.id))));
    await f.store.save({ ...f.store.get(job.id)!, audioRetained: false });
    assert.equal((await f.request(endpoint)).status, 410);
    assert.equal((await f.request(endpoint, { method: "POST" })).status, 410);
    assert.equal((await f.request(`${f.base}${result.url}`)).status, 404);
    await f.store.save({ ...f.store.get(job.id)!, audioRetained: true });
    assert.equal((await f.request(`${f.base}/api/jobs/${job.id}`, { method: "DELETE" })).status, 204);
    await assert.rejects(stat(f.store.playbackPath(job.id)), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("playback never publishes empty or byte-capped output and reserves for expanded CBR audio", () => {
  assert(MAX_PLAYBACK_BYTES > 4 * 60 * 60 * 192000 / 8);
  validatePlaybackSize(MAX_PLAYBACK_BYTES - 65537);
  for (const size of [0, MAX_PLAYBACK_BYTES - 65536, MAX_PLAYBACK_BYTES, MAX_PLAYBACK_BYTES + 1000]) {
    assert.throws(() => validatePlaybackSize(size), /empty or exceeds/);
  }
});

test("Opus stays on its original playback path", async () => {
  const f = await createSessionFixture("scribe-playback-opus-");
  try {
    const job = await f.save({ ...createDemo(), demo: false, audioRetained: true, originalName: "test.opus" });
    await writeFile(f.store.audioPath(job.id), "opus-fixture");
    const response = await f.request(`${f.base}/api/jobs/${job.id}/playback`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready", url: `/api/jobs/${job.id}/audio` });
    assert.equal((await f.request(`${f.base}/api/jobs/${job.id}/playback`, { method: "POST" })).status, 400);
    assert.equal(f.store.get(job.id)!.playbackRepairRequested, undefined);
    await assert.rejects(stat(f.store.playbackPath(job.id)), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("playback failures and low disk space surface explicitly and leave no temporary cache", async () => {
  const f = await createSessionFixture("scribe-playback-error-");
  try {
    const job = await f.save({ ...createDemo(), demo: false, audioRetained: true });
    const source = f.store.audioPath(job.id);
    const output = f.store.playbackPath(job.id);
    await writeFile(source, "invalid-audio");
    const playback = new PlaybackAudio(config.ffmpeg);
    await assert.rejects(playback.prepare(job.id, source, output, 60000), /Audio processing failed/);
    assert.equal(playback.isGenerating(job.id), false);
    await assert.rejects(stat(output), { code: "ENOENT" });
    assert.equal((await readdir(f.store.directory(job.id))).some(file => file.endsWith(".tmp")), false);
    const full = new PlaybackAudio(config.ffmpeg, Number.MAX_SAFE_INTEGER);
    await assert.rejects(full.prepare(job.id, source, output, 60000), { status: 507 });
    assert.equal(await readFile(source, "utf8"), "invalid-audio");
  } finally { await f.close(); }
});

test("playback admission is bounded and shutdown cancels pending preparation before releasing files", async () => {
  const f = await createSessionFixture("scribe-playback-stop-");
  try {
    const playback = new PlaybackAudio(config.ffmpeg);
    const jobs = await Promise.all(Array.from({ length: 3 }, () => f.save({ ...createDemo(), audioRetained: true })));
    for (const job of jobs) await writeFile(f.store.audioPath(job.id), "fixture");
    const start = (index: number) => playback.prepare(jobs[index]!.id, f.store.audioPath(jobs[index]!.id),
      f.store.playbackPath(jobs[index]!.id), 60000);
    const pending = Promise.allSettled([start(0), start(1)]);
    await assert.rejects(start(2), { status: 429 });
    await playback.stop();
    const results = await pending;
    assert(results.every(result => result.status === "rejected"));
    assert.equal(playback.isGenerating(jobs[0]!.id), false);
    assert.equal(playback.isGenerating(jobs[1]!.id), false);
    await assert.rejects(start(2), /stopping/);
    for (const job of jobs) {
      assert.equal((await readdir(f.store.directory(job.id))).some(file => file.endsWith(".tmp")), false);
    }
  } finally { await f.close(); }
});
