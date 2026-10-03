import { rm } from "node:fs/promises";
import { config, readiness } from "./config.js";
import { inspectDecodedDuration, inspectRecording, normalizeAudio } from "./audio.js";
import { AzureSpeech } from "./azure.js";
import { recordingAvailable, recordingState, type Job, type Progress, type ProgressStep, type ProgressStepKey } from "./domain.js";
import { StageTimings } from "./timings.js";
import { generateRecap } from "./recap.js";
import { JobStore } from "./store.js";
import { LaughterDetector, type LaughterDetection } from "./laughter.js";

export const activeStatuses = new Set(["queued", "normalizing", "uploading", "transcribing", "summarizing"]);
export const activeLaughterStatuses = new Set(["queued", "running"]);
type QueueItem = { id: string; operation: "process" | "recap" | "laughter" };
// Speech output can be slightly longer than container metadata; differences beyond this are charged.
const DURATION_TOLERANCE_MS = 10_000;
const MAX_TRANSCRIPTION_MS = 4 * 60 * 60 * 1000;
const STEP_LABELS: Record<ProgressStepKey, string> = {
  prepare: "Check recording and mix to mono",
  upload: "Upload audio for transcription",
  submit: "Submit to Azure Speech",
  laughter: "Detect laughter",
  transcribe: "Transcribe and identify speakers",
  recap: "Write the session recap",
  cleanup: "Clean up temporary files",
};

// Converts the recap pipeline's stage messages into real sub-progress for the recap step.
export function recapFraction(stage: string): number | undefined {
  const match = /^(Reading story scenes|Combining story notes) (\d+) of (\d+)/.exec(stage);
  if (match) {
    const done = (Number(match[2]) - 1) / Math.max(1, Number(match[3]));
    return match[1] === "Reading story scenes" ? done * 0.75 : 0.75 + done * 0.15;
  }
  return /^Writing/.test(stage) ? 0.9 : undefined;
}

export class JobRunner {
  private queue: QueueItem[] = [];
  private running = false;
  private stopped = false;
  private criticalSections = 0;
  readonly busyIds = new Set<string>();
  // Set by the server: queued work for suspended/removed owners must not keep spending Azure money.
  canProcess: (id: string) => boolean = () => true;
  // Set by the server: charges decoded audio beyond the declared duration to the owner's quota (throws when over).
  chargeExtraAudio: (id: string, extraMs: number) => void = () => {};
  private reserved = new Set<string>();
  // Learned stage durations; the server points this at DATA_DIR so estimates improve over time.
  timings = new StageTimings();
  private stepStarts = new Map<string, number>();
  constructor(
    private store: JobStore,
    private speech = new AzureSpeech(),
    private recap = generateRecap,
    private laughter: LaughterDetection = new LaughterDetector(),
  ) {}

  enqueue(id: string) {
    this.enqueueOperation(id, "process");
  }

  // Recap-only work never (re)transcribes, even if the transcript was emptied after queuing.
  enqueueRecap(id: string) {
    this.enqueueOperation(id, "recap");
  }

  // Marks a job busy synchronously so concurrent edits are refused before the caller's async work.
  reserve(id: string): boolean {
    if (this.busyIds.has(id)) return false;
    this.busyIds.add(id);
    this.reserved.add(id);
    return true;
  }
  release(id: string) {
    if (this.reserved.delete(id)) this.busyIds.delete(id);
  }

  enqueueLaughter(id: string) {
    this.enqueueOperation(id, "laughter");
  }

  private enqueueOperation(id: string, operation: QueueItem["operation"]) {
    if (this.reserved.has(id)) this.reserved.delete(id);
    else if (this.busyIds.has(id)) throw new Error("Job is already processing.");
    this.busyIds.add(id);
    this.queue.push({ id, operation });
    void this.drain().catch(error => {
      console.error("Job queue persistence failure; restart the server after checking disk access.", error);
    });
  }

  private async update(id: string, patch: Partial<Job>) {
    const current = this.store.get(id);
    if (!current) throw new Error("Processing job disappeared.");
    return this.store.save({ ...current, ...patch });
  }

  get inCriticalSection() { return this.criticalSections > 0; }

  // Starts a new step plan, or keeps the unfinished plan of the same kind when resuming after a restart.
  private async plan(id: string, kind: Progress["kind"], keys: Array<[ProgressStepKey, boolean]>) {
    const job = this.store.get(id)!;
    if (job.progress && !job.progress.finishedAt && job.progress.kind === kind) return job;
    const audioMs = job.durationMs ?? 0;
    const steps: ProgressStep[] = [];
    for (const [key, skip] of keys) {
      steps.push({ key, label: STEP_LABELS[key], status: skip ? "skipped" : "pending",
        estimateMs: skip ? 0 : await this.timings.estimate(key, audioMs) });
    }
    return this.update(id, { progress: { kind, startedAt: new Date().toISOString(), steps } });
  }
  private hasStep(id: string, key: ProgressStepKey, ...statuses: ProgressStep["status"][]) {
    return !!this.store.get(id)?.progress?.steps.some(step => step.key === key && statuses.includes(step.status));
  }
  private async stepUpdate(id: string, key: ProgressStepKey, patch: Partial<ProgressStep>, jobPatch: Partial<Job> = {}) {
    const progress = this.store.get(id)?.progress;
    if (!progress?.steps.some(step => step.key === key)) return this.update(id, jobPatch);
    const steps = progress.steps.map(step => step.key === key ? { ...step, ...patch } : step);
    return this.update(id, { ...jobPatch, progress: { ...progress, steps } });
  }
  private async startStep(id: string, key: ProgressStepKey, jobPatch: Partial<Job> = {}) {
    const resumed = this.hasStep(id, key, "running");
    // A step that was already running before a restart keeps its start time but is not used for timing stats.
    if (!resumed) this.stepStarts.set(`${id}:${key}`, Date.now());
    return this.stepUpdate(id, key, resumed ? {} : { status: "running", startedAt: new Date().toISOString(),
      endedAt: undefined, detail: undefined, fraction: undefined }, jobPatch);
  }
  private async endStep(id: string, key: ProgressStepKey, status: "done" | "failed" | "skipped", jobPatch: Partial<Job> = {}) {
    const started = this.stepStarts.get(`${id}:${key}`);
    this.stepStarts.delete(`${id}:${key}`);
    if (status === "done" && started !== undefined) {
      const elapsedMs = Date.now() - started;
      const audioMs = this.store.get(id)?.durationMs ?? 0;
      console.log(`Session ${id}: "${STEP_LABELS[key]}" took ${(elapsedMs / 1000).toFixed(1)} s for ${(audioMs / 60_000).toFixed(1)} min of audio.`);
      await this.timings.record(key, elapsedMs, audioMs);
    }
    return this.stepUpdate(id, key, { status, endedAt: new Date().toISOString(),
      ...(status === "done" ? { fraction: 1 } : {}) }, jobPatch);
  }
  private async finishRun(id: string, outcome: "completed" | "failed") {
    const progress = this.store.get(id)?.progress;
    if (!progress || progress.finishedAt) return;
    const now = new Date().toISOString();
    const steps = progress.steps.map(step => step.status === "running"
      ? { ...step, status: outcome === "failed" ? "failed" as const : "done" as const, endedAt: now } : step);
    await this.update(id, { progress: { ...progress, steps, finishedAt: now, outcome } });
  }

  // Stop taking new work. In-flight work is abandoned at process exit and resumed from persisted state.
  stop() { this.stopped = true; }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const { id, operation } = this.queue.shift()!;
        try {
          if (operation === "laughter") await this.processLaughter(id);
          else await this.process(id, operation === "recap");
        } finally {
          this.busyIds.delete(id);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async detectLaughter(job: Job, updateStage: boolean): Promise<Job> {
    if (job.demo || job.laughter.status === "completed" || job.laughter.status === "skipped") {
      return this.hasStep(job.id, "laughter", "pending", "running") ? this.endStep(job.id, "laughter", "skipped") : job;
    }
    if (!this.laughter.enabled) {
      return this.endStep(job.id, "laughter", "skipped", {
        laughter: { status: "skipped", events: [], error: "Laughter detection is disabled." },
      });
    }
    if (!recordingAvailable(job) || !job.durationMs) {
      return this.endStep(job.id, "laughter", "failed", {
        laughter: { status: "failed", events: [], error: "A retained recording with a known duration is required." },
      });
    }
    const durationMs = job.durationMs;
    job = await this.startStep(job.id, "laughter", {
      ...(updateStage ? { stage: "Detecting laughter with YAMNet" } : {}),
      laughter: { ...job.laughter, status: "running", error: undefined },
    });
    try {
      const result = await this.laughter.detect(this.store.audioPath(job.id), durationMs);
      return this.endStep(job.id, "laughter", "done", {
        laughter: {
          status: "completed",
          events: result.events,
          model: result.model,
          modelVersion: result.modelVersion,
          profileVersion: result.profileVersion,
          completedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected laughter detection failure.";
      console.error(`Laughter detection for job ${job.id} failed: ${message}`);
      return this.endStep(job.id, "laughter", "failed", {
        laughter: { ...job.laughter, status: "failed", events: job.laughter.events, error: message },
      });
    }
  }

  private async processLaughter(id: string) {
    if (!this.store.get(id)) throw new Error("Processing job disappeared.");
    const job = await this.plan(id, "laughter", [["laughter", false]]);
    const result = await this.detectLaughter(job, false);
    await this.finishRun(id, result.laughter.status === "failed" ? "failed" : "completed");
  }

  private async process(id: string, recapOnly = false) {
    let job = this.store.get(id)!;
    let outcome: "completed" | "failed" = "completed";
    try {
      const transcribed = job.segments.length > 0;
      const submitted = transcribed || !!job.speechJobUrl;
      const laughterSettled = job.demo || !this.laughter.enabled ||
        job.laughter.status === "completed" || job.laughter.status === "skipped";
      job = recapOnly ? await this.plan(id, "recap", [["recap", false]]) : await this.plan(id, "process", [
        ["prepare", submitted], ["upload", submitted], ["submit", submitted],
        ["laughter", transcribed || laughterSettled], ["transcribe", transcribed],
        ["recap", readiness().recapMissing.length > 0], ["cleanup", false],
      ]);
      if (!this.canProcess(id)) throw new Error("The session owner's account is no longer active, so processing stopped.");
      if (recapOnly && !job.segments.length) throw new Error("A transcript is required before generating a recap.");
      if (!job.segments.length && !job.speechJobUrl && recordingState(job) === "expired") {
        throw new Error("The original recording is no longer available for transcription.");
      }
      if (!job.segments.length) {
        if (readiness().transcriptionMissing.length) throw new Error("Azure Speech/Storage configuration is incomplete.");
        if (!job.speechJobUrl) {
          job = await this.startStep(id, "prepare", { status: "normalizing", stage: "Checking recording and mixing to mono for diarization", error: undefined });
          const durationMs = await inspectRecording(config.ffprobe, this.store.audioPath(id), job.originalName);
          job = await this.update(id, { durationMs, audioRetained: true });
          await normalizeAudio(config.ffmpeg, this.store.audioPath(id), this.store.monoPath(id), MAX_TRANSCRIPTION_MS + 60_000);
          // Container metadata can understate length; bill and bound the audio Speech will actually receive.
          const decodedMs = await inspectDecodedDuration(config.ffprobe, this.store.monoPath(id));
          if (decodedMs > MAX_TRANSCRIPTION_MS + 30_000) {
            throw new Error("This recording exceeds Azure batch diarization's 4-hour limit. Split it manually; speaker labels will not carry across files.");
          }
          if (decodedMs > durationMs + DURATION_TOLERANCE_MS) this.chargeExtraAudio(id, decodedMs - durationMs);
          job = await this.endStep(id, "prepare", "done", { durationMs: Math.max(durationMs, decodedMs) });
          job = await this.startStep(id, "upload", { status: "uploading", stage: "Uploading to private Azure Blob Storage", blobName: `${id}/mono.mp3` });
          const audioUrl = await this.speech.upload(this.store.monoPath(id), job.blobName!);
          job = await this.endStep(id, "upload", "done");
          // Shutdown waits for this window so a submitted (billable) Speech job is never forgotten and resubmitted.
          this.criticalSections++;
          try {
            job = await this.startStep(id, "submit");
            const speechJobUrl = await this.speech.submit(job, audioUrl);
            job = await this.endStep(id, "submit", "done", { speechJobUrl, status: "transcribing", stage: "Azure Speech job submitted" });
          } finally { this.criticalSections--; }
        }
        job = await this.detectLaughter(job, true);
        job = await this.startStep(id, "transcribe", { status: "transcribing" });
        const result = await this.speech.waitForTranscript(job.speechJobUrl!, async status => {
          await this.stepUpdate(id, "transcribe", { detail: status === "NotStarted" ? "Waiting in Azure's queue" : "Azure is transcribing" },
            { status: "transcribing", stage: `Azure Speech: ${status}. Batch processing can take minutes to hours.` });
        });
        job = await this.endStep(id, "transcribe", "done", {
          status: "transcript_ready", stage: "Transcript saved",
          segments: result.segments, warnings: [...job.warnings, ...result.warnings],
        });
      }
      if (readiness().recapMissing.length) throw new Error("Transcript is ready. Configure Azure OpenAI to generate its recap.");
      job = await this.startStep(id, "recap", { status: "summarizing", stage: "Preparing evidence-grounded recap", error: undefined });
      const recap = await this.recap(job, async stage => {
        const fraction = recapFraction(stage);
        await this.stepUpdate(id, "recap", { detail: stage, ...(fraction === undefined ? {} : { fraction }) }, { stage });
      });
      job = await this.endStep(id, "recap", "done", { recap, recapStale: false, status: "completed", stage: "Transcript and recap ready", queuedOperation: undefined });
    } catch (error) {
      outcome = "failed";
      const message = error instanceof Error ? error.message : "Unexpected processing failure.";
      console.error(`Job ${id} failed: ${message}`);
      job = await this.update(id, {
        status: this.store.get(id)!.segments.length ? "transcript_ready" : "failed",
        stage: this.store.get(id)!.segments.length ? "Transcript saved; recap requires attention" : "Processing failed",
        error: message, queuedOperation: undefined,
      });
    } finally {
      // A step that was still running when processing failed is the one that failed.
      const running = this.store.get(id)?.progress?.steps.find(step => step.status === "running" && step.key !== "cleanup");
      if (running) await this.endStep(id, running.key, outcome === "failed" ? "failed" : "done");
      if (this.hasStep(id, "cleanup", "pending", "running")) await this.startStep(id, "cleanup");
      const warnings = await this.speech.cleanup(job);
      for (const file of [this.store.monoPath(id)]) {
        try { await rm(file, { force: true }); }
        catch { warnings.push("Could not delete normalized local audio. Remove mono.mp3 manually from this job's data directory."); }
      }
      if (warnings.length) {
        console.warn(`Job ${id} cleanup warnings: ${warnings.join(" ")}`);
        await this.update(id, { warnings: [...this.store.get(id)!.warnings, ...warnings] });
      }
      // Keep failed cleanup handles for deletion retries, but not successful ones.
      if (!warnings.length) await this.update(id, { speechJobUrl: undefined, blobName: undefined });
      if (this.hasStep(id, "cleanup", "running")) await this.endStep(id, "cleanup", "done");
      await this.finishRun(id, outcome);
    }
  }
}
