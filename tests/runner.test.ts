import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AzureSpeech } from "../src/azure.js";
import { runTool, inspectRecording } from "../src/audio.js";
import { config } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { type Job } from "../src/domain.js";
import { JobRunner, recapFraction } from "../src/runner.js";
import { StageTimings } from "../src/timings.js";
import { RecapModelError } from "../src/recap.js";
import { JobStore } from "../src/store.js";
import type { LaughterDetection } from "../src/laughter.js";

class FakeSpeech extends AzureSpeech {
  uploads = 0;
  submissions = 0;
  cleanupCalls = 0;
  async upload(file: string, _blobName: string) {
    await access(file);
    this.uploads++;
    return "https://fixture.blob.core.windows.net/audio.mp3";
  }

  async submit(_job: Job, _url: string) {
    this.submissions++;
    return "https://fixture.cognitiveservices.azure.com/speechtotext/transcriptions/fixture";
  }
  async waitForTranscript(_url: string, onStatus: (status: string) => Promise<void>) {
    await onStatus("Running");
    return { segments: createDemo().segments, warnings: [] };
  }
  async cleanup(_job: Job) { this.cleanupCalls++; return []; }
}

const noLaughter: LaughterDetection = {
  enabled: true,
  async detect() {
    return { schemaVersion: 1, model: "yamnet", modelVersion: "1", profileVersion: "test", events: [] };
  },
};

async function wait(runner: JobRunner, id: string) {
  const deadline = Date.now() + 15_000;
  while (runner.busyIds.has(id)) {
    if (Date.now() > deadline) throw new Error("Worker test timed out.");
    await delay(20);
  }
}

test("worker: actual MP3 mixdown, persisted transcript, recap failure/retry, saved-job resume and cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnd-worker-test-"));
  const originalConfig = { ...config };
  Object.assign(config, {
    speechEndpoint: "https://fixture.cognitiveservices.azure.com",
    storageAccountUrl: "https://fixture.blob.core.windows.net", openaiEndpoint: "https://fixture.openai.azure.com",
    openaiDeployment: "fixture", authMode: "azure-cli",
  });
  try {
    const store = new JobStore(root);
    await store.init();
    const speech = new FakeSpeech();
    const job = {
      ...createDemo(), demo: false, status: "queued" as const, segments: [], recap: undefined,
      laughter: { status: "pending" as const, events: [] },
    };
    await store.save(job);
    await runTool(config.ffmpeg, [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-ac", "2", "-codec:a", "libmp3lame", store.audioPath(job.id),
    ], 10_000);
    assert((await inspectRecording(config.ffprobe, store.audioPath(job.id), job.originalName)) > 0);
    const failedRecapRunner = new JobRunner(store, speech, async () => { throw new Error("Fixture recap failure"); }, noLaughter);
    failedRecapRunner.timings = StageTimings.inDirectory(root);
    failedRecapRunner.enqueue(job.id);
    await wait(failedRecapRunner, job.id);
    const failedRun = store.get(job.id)!.progress!;
    assert.equal(failedRun.kind, "process");
    assert.equal(failedRun.outcome, "failed");
    assert.ok(failedRun.finishedAt);
    assert.deepEqual(failedRun.steps.map(step => `${step.key}:${step.status}`), [
      "prepare:done", "upload:done", "submit:done", "laughter:done", "waveform:done", "transcribe:done", "recap:failed", "cleanup:done"]);
    assert.ok(failedRun.steps.every(step => step.estimateMs > 0));
    const timings = JSON.parse(await readFile(path.join(root, "stage-timings.json"), "utf8"));
    assert.deepEqual(Object.keys(timings).sort(), ["cleanup", "laughter", "prepare", "submit", "transcribe", "upload", "waveform"]);
    assert.equal(store.get(job.id)!.status, "transcript_ready");
    assert.equal(store.get(job.id)!.segments.length, 8);
    assert.equal(store.get(job.id)!.laughter.status, "completed");
    assert.equal(store.get(job.id)!.error, "Fixture recap failure");
    assert.equal(speech.uploads, 1);
    assert.equal(speech.submissions, 1);
    await access(store.audioPath(job.id));
    assert.equal(store.get(job.id)!.audioRetained, true);
    await assert.rejects(access(store.monoPath(job.id)), /ENOENT/);
    const retry = new JobRunner(store, speech, async () => createDemo().recap!, noLaughter);
    retry.enqueue(job.id);
    await wait(retry, job.id);
    assert.equal(store.get(job.id)!.status, "completed");
    assert.equal(store.get(job.id)!.error, undefined);
    assert.equal(speech.submissions, 1, "recap retry must not retranscribe");
    const retryRun = store.get(job.id)!.progress!;
    assert.equal(retryRun.outcome, "completed");
    assert.deepEqual(retryRun.steps.filter(step => step.status !== "skipped").map(step => `${step.key}:${step.status}`),
      ["recap:done", "cleanup:done"]);

    const resumed = {
      ...createDemo(), demo: false, status: "transcribing" as const, segments: [], recap: undefined,
      speechJobUrl: "https://fixture.cognitiveservices.azure.com/speechtotext/transcriptions/saved",
    };
    await store.save(resumed);
    const resume = new JobRunner(store, speech, async () => createDemo().recap!, noLaughter);
    resume.enqueue(resumed.id);
    await wait(resume, resumed.id);
    assert.equal(store.get(resumed.id)!.status, "completed");
    assert.equal(speech.submissions, 1, "saved Azure jobs must be polled, not resubmitted");
    const reloaded = new JobStore(root);
    await reloaded.init();
    assert.equal(reloaded.get(job.id)!.status, "completed");
    assert.equal(reloaded.get(resumed.id)!.recap!.title, "The Lantern Below");
  } finally {
    Object.assign(config, originalConfig);
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone laughter analysis preserves completed transcript and recap state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnd-laughter-worker-test-"));
  try {
    const store = new JobStore(root);
    await store.init();
    const job = await store.save({ ...createDemo(), demo: false, audioRetained: true,
      laughter: { status: "queued", events: [] } });
    await runTool(config.ffmpeg, [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-codec:a", "libmp3lame", store.audioPath(job.id),
    ], 10_000);
    const detector: LaughterDetection = {
      enabled: true,
      async detect(_audio, durationMs) {
        assert.equal(durationMs, job.durationMs);
        return {
          schemaVersion: 1, model: "yamnet", modelVersion: "1", profileVersion: "test",
          events: [{
            id: "L00001", startMs: 1000, endMs: 2000, peakMs: 1500,
            peakConfidence: 0.8, meanConfidence: 0.6,
            labels: [{ name: "Laughter", peakConfidence: 0.8 }],
          }],
        };
      },
    };
    const runner = new JobRunner(store, new FakeSpeech(), async () => job.recap!, detector);
    runner.enqueueLaughter(job.id);
    await wait(runner, job.id);
    const updated = store.get(job.id)!;
    assert.equal(updated.status, "completed");
    assert.deepEqual(updated.recap, job.recap);
    assert.equal(updated.stage, job.stage);
    assert.equal(updated.laughter.status, "completed");
    assert.equal(updated.laughter.events[0]!.startMs, 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recap regeneration preserves stale recap on failure and clears dirty marker only after success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnd-recap-dirty-test-"));
  const originalConfig = { ...config };
  Object.assign(config, {
    openaiEndpoint: "https://fixture.openai.azure.com", openaiDeployment: "fixture", authMode: "azure-cli",
  });
  try {
    const store = new JobStore(root);
    const job = await store.save({ ...createDemo(), demo: false, recapStale: true, status: "transcript_ready" });
    const speech = new FakeSpeech();
    const failed = new JobRunner(store, speech, async () => { throw new Error("Fixture regeneration failure"); }, noLaughter);
    failed.enqueue(job.id);
    await wait(failed, job.id);
    assert.deepEqual(store.get(job.id)!.recap, job.recap);
    assert.equal(store.get(job.id)!.recapStale, true);
    const replacement = { ...createDemo().recap!, title: "Regenerated recap" };
    const retry = new JobRunner(store, speech, async () => replacement, noLaughter);
    retry.enqueue(job.id);
    await wait(retry, job.id);
    assert.deepEqual(store.get(job.id)!.recap, replacement);
    assert.equal(store.get(job.id)!.recapStale, false);
    assert.equal(speech.uploads, 0);
    assert.equal(speech.submissions, 0);
    const reloaded = new JobStore(root);
    await reloaded.init();
    assert.equal(reloaded.get(job.id)!.recapStale, false);
  } finally {
    Object.assign(config, originalConfig);
    await rm(root, { recursive: true, force: true });
  }
});

test("worker accepts actual stereo Ogg Opus, retains original playback audio, and cleans normalized audio", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnd-opus-worker-test-"));
  const originalConfig = { ...config };
  Object.assign(config, {
    speechEndpoint: "https://fixture.cognitiveservices.azure.com",
    storageAccountUrl: "https://fixture.blob.core.windows.net",
    openaiEndpoint: "https://fixture.openai.azure.com", openaiDeployment: "fixture", authMode: "azure-cli",
  });
  try {
    const store = new JobStore(root);
    await store.init();
    const job = {
      ...createDemo(), originalName: "party.OPUS", demo: false, status: "queued" as const,
      segments: [], recap: undefined, warnings: [],
    };
    await store.save(job);
    await runTool(config.ffmpeg, [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-ar", "48000", "-ac", "2", "-codec:a", "libopus", "-f", "ogg", store.audioPath(job.id),
    ], 10_000);
    assert((await inspectRecording(config.ffprobe, store.audioPath(job.id), job.originalName)) > 0);
    const speech = new FakeSpeech();
    speech.upload = async (file: string) => {
      const metadata = JSON.parse(await runTool(config.ffprobe, [
        "-v", "error", "-show_entries", "format=format_name:stream=codec_name,channels,sample_rate",
        "-of", "json", file,
      ], 10_000));
      assert.equal(metadata.format.format_name, "mp3");
      assert.equal(metadata.streams[0].codec_name, "mp3");
      assert.equal(metadata.streams[0].channels, 1);
      assert.equal(metadata.streams[0].sample_rate, "16000");
      speech.uploads++;
      return "https://fixture.blob.core.windows.net/audio.mp3";
    };
    const runner = new JobRunner(store, speech, async () => createDemo().recap!, noLaughter);
    runner.enqueue(job.id);
    await wait(runner, job.id);
    assert.equal(store.get(job.id)!.status, "completed");
    assert.equal(store.get(job.id)!.originalName, "party.OPUS");
    assert.equal(speech.uploads, 1);
    assert.equal(speech.submissions, 1);
    assert.deepEqual(store.get(job.id)!.warnings, []);
    await access(store.audioPath(job.id));
    assert.equal(store.get(job.id)!.audioRetained, true);
    await assert.rejects(access(store.monoPath(job.id)), /ENOENT/);

    const renamedMp3 = {
      ...createDemo(), originalName: "renamed.opus", demo: false, status: "queued" as const,
      segments: [], recap: undefined, audioRetained: true,
    };
    await store.save(renamedMp3);
    await runTool(config.ffmpeg, [
      "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-codec:a", "libmp3lame", store.audioPath(renamedMp3.id),
    ], 10_000);
    runner.enqueue(renamedMp3.id);
    await wait(runner, renamedMp3.id);
    assert.equal(store.get(renamedMp3.id)!.status, "failed");
    assert.match(store.get(renamedMp3.id)!.error!, /not a valid Ogg Opus/);
    assert.equal(speech.uploads, 1, "mislabeled recordings must be rejected before cloud upload");
    await access(store.audioPath(renamedMp3.id));
  } finally {
    Object.assign(config, originalConfig);
    await rm(root, { recursive: true, force: true });
  }
});

test("recap progress messages map to monotonic sub-progress, and stage timings learn from history", async () => {
  assert.equal(recapFraction("Reading story scenes 1 of 4"), 0);
  assert.equal(recapFraction("Reading story scenes 3 of 4"), 0.375);
  assert.equal(recapFraction("Combining story notes 1 of 2"), 0.75);
  assert.equal(recapFraction("Writing the chronological session recap"), 0.9);
  assert.equal(recapFraction("Preparing"), undefined);
  const timings = new StageTimings();
  const hour = 60 * 60_000;
  const guess = await timings.estimate("transcribe", hour);
  assert.ok(guess > 60_000);
  for (const minutes of [5, 6, 7]) await timings.record("transcribe", minutes * 60_000, hour);
  assert.equal(await timings.estimate("transcribe", hour), 6 * 60_000);
  // Fixed queue overhead (1 min) is not multiplied by recording length.
  assert.equal(await timings.estimate("transcribe", 2 * hour), 11 * 60_000);
  await timings.record("submit", 4000, hour);
  assert.equal(await timings.estimate("submit", 3 * hour), 4000, "fixed-cost stages do not scale with length");
});
test("sessions run side by side: a long Azure wait doesn't block a short session, and laughter runs during the wait", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnd-concurrency-test-"));
  const originalConfig = { ...config };
  Object.assign(config, {
    speechEndpoint: "https://fixture.cognitiveservices.azure.com",
    storageAccountUrl: "https://fixture.blob.core.windows.net", openaiEndpoint: "https://fixture.openai.azure.com",
    openaiDeployment: "fixture", authMode: "azure-cli",
  });
  try {
    const store = new JobStore(root);
    await store.init();
    let releaseLong!: () => void;
    const longWait = new Promise<void>(resolve => { releaseLong = resolve; });
    let laughterDuringLongWait = false;
    let cpuOverlap = 0, cpuActive = 0;
    class GatedSpeech extends FakeSpeech {
      async waitForTranscript(url: string, onStatus: (status: string) => Promise<void>) {
        if (url.endsWith("/long")) await longWait;
        return super.waitForTranscript(url, onStatus);
      }
      async submit(job: Job, _url: string) { return `https://fixture.cognitiveservices.azure.com/speechtotext/transcriptions/${job.title}`; }
    }
    const trackingLaughter: LaughterDetection = {
      enabled: true,
      async detect() {
        cpuActive++; cpuOverlap = Math.max(cpuOverlap, cpuActive);
        await delay(30);
        cpuActive--;
        laughterDuringLongWait ||= !store.list().find(job => job.title === "long")?.segments.length;
        return { schemaVersion: 1, model: "yamnet", modelVersion: "1", profileVersion: "test", events: [] };
      },
    };
    let failRegeneration = true;
    const runner = new JobRunner(store, new GatedSpeech(), async job => {
      if (job.title === "regenerate") {
        assert.equal(job.clarifications[0]!.text, "Mira cast the ward.");
        if (failRegeneration) throw new RecapModelError("content_filter", ["violence: medium"]);
        return { ...job.recap!, title: "Regenerated with clarifications" };
      }
      return createDemo().recap!;
    }, trackingLaughter);
    const make = async (title: string) => {
      const job = await store.save({ ...createDemo(), demo: false, title, status: "queued" as const, segments: [], recap: undefined,
        audioRetained: true, laughter: { status: "pending" as const, events: [] } });
      await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-codec:a", "libmp3lame", store.audioPath(job.id)], 10_000);
      return job;
    };
    const long = await make("long");
    const short = await make("short");
    runner.enqueue(long.id);
    runner.enqueue(short.id);
    await wait(runner, short.id);
    assert.equal(store.get(short.id)!.status, "completed", "the short session finishes while the long one waits on Azure");
    assert.equal(runner.busyIds.has(long.id), true);
    assert.equal(store.get(long.id)!.laughter.status, "completed", "laughter ran during the Azure wait");
    assert.equal(laughterDuringLongWait, true);
    const regenerate = await store.save({
      ...createDemo(), demo: false, title: "regenerate", recapStale: true, status: "queued",
      clarifications: [{ id: "c1", text: "Mira cast the ward.", createdAt: new Date().toISOString() }],
    });
    runner.enqueueRecap(regenerate.id);
    await wait(runner, regenerate.id);
    const failed = store.get(regenerate.id)!;
    assert.equal(failed.status, "transcript_ready");
    assert.match(failed.error!, /content filter.*violence: medium/);
    assert.deepEqual(failed.recap, regenerate.recap);
    assert.deepEqual(failed.segments, regenerate.segments);
    assert.deepEqual(failed.clarifications, regenerate.clarifications);
    assert.equal(failed.recapStale, true);
    assert.equal(runner.busyIds.has(long.id), true, "recap failure does not stop another session");
    failRegeneration = false;
    runner.enqueueRecap(regenerate.id);
    await wait(runner, regenerate.id);
    assert.equal(store.get(regenerate.id)!.recap!.title, "Regenerated with clarifications");
    assert.equal(store.get(regenerate.id)!.recapStale, false);
    assert.deepEqual(store.get(regenerate.id)!.clarifications, regenerate.clarifications);
    releaseLong();
    await wait(runner, long.id);
    assert.equal(store.get(long.id)!.status, "completed");
    assert.equal(cpuOverlap, 1, "CPU-heavy steps never overlap");
  } finally {
    Object.assign(config, originalConfig);
    await rm(root, { recursive: true, force: true });
  }
});
test("cancelling a running session stops it at the next checkpoint, still cleans up, and reports why", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnd-cancel-test-"));
  const originalConfig = { ...config };
  Object.assign(config, {
    speechEndpoint: "https://fixture.cognitiveservices.azure.com",
    storageAccountUrl: "https://fixture.blob.core.windows.net", openaiEndpoint: "https://fixture.openai.azure.com",
    openaiDeployment: "fixture", authMode: "azure-cli",
  });
  try {
    const store = new JobStore(root);
    await store.init();
    class SlowSpeech extends FakeSpeech {
      async waitForTranscript(_url: string, onStatus: (status: string) => Promise<void>) {
        for (;;) { await onStatus("Running"); await delay(20); }
      }
    }
    const speech = new SlowSpeech();
    const runner = new JobRunner(store, speech, async () => createDemo().recap!, noLaughter);
    const finished: string[] = [];
    runner.afterRun = id => { finished.push(id); };
    const job = await store.save({ ...createDemo(), demo: false, status: "queued" as const, segments: [], recap: undefined,
      audioRetained: true, laughter: { status: "pending" as const, events: [] } });
    await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-codec:a", "libmp3lame", store.audioPath(job.id)], 10_000);
    runner.enqueue(job.id);
    for (let attempt = 0; attempt < 200 && !store.get(job.id)!.progress?.steps.some(step => step.key === "transcribe" && step.status === "running"); attempt++) await delay(20);
    assert.equal(runner.cancel(job.id), true);
    await wait(runner, job.id);
    assert.match(store.get(job.id)!.error ?? "", /stopped because the session is being deleted/);
    assert.equal(speech.cleanupCalls, 1, "Azure cleanup still runs");
    assert.deepEqual(finished, [job.id]);
    assert.equal(runner.cancel(job.id), false, "nothing to cancel once stopped");
  } finally {
    Object.assign(config, originalConfig);
    await rm(root, { recursive: true, force: true });
  }
});