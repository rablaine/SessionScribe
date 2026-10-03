import { rm } from "node:fs/promises";
import { config, readiness } from "./config.js";
import { inspectDecodedDuration, inspectRecording, normalizeAudio } from "./audio.js";
import { AzureSpeech } from "./azure.js";
import { recordingAvailable, recordingState, type Job, type Progress, type ProgressStep, type ProgressStepKey } from "./domain.js";
import { StageTimings } from "./timings.js";
import { generateRecap } from "./recap.js";
import { JobStore } from "./store.js";
import { LaughterDetector, type LaughterDetection } from "./laughter.js";
import { applyNameList, callSuggestModel, suggestNameFixes, type NameEntry, type SuggestCaller } from "./names.js";

export const activeStatuses = new Set(["queued", "normalizing", "uploading", "transcribing", "summarizing", "checking_names"]);
export const activeLaughterStatuses = new Set(["queued", "running"]);
type QueueItem = { id: string; operation: "process" | "recap" | "laughter" | "names" };
// Speech output can be slightly longer than container metadata; differences beyond this are charged.
const DURATION_TOLERANCE_MS = 10_000;
const MAX_TRANSCRIPTION_MS = 4 * 60 * 60 * 1000;
// Sessions processed side by side. Most of a session's wall time is spent waiting on Azure Speech, which uses no
// local resources, so several can be in flight while CPU-heavy steps take turns (see JobRunner.cpu).
export const MAX_ACTIVE_JOBS = 6;
const STEP_LABELS: Record<ProgressStepKey, string> = {
  prepare: "Check recording and mix to mono",
  upload: "Upload audio for transcription",
  submit: "Submit to Azure Speech",
  laughter: "Detect laughter",
  waveform: "Build the clip editor waveform",
  transcribe: "Transcribe and identify speakers",
  names: "Look for misheard names",
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

export class CancelledError extends Error {
  constructor() { super("Processing was stopped because the session is being deleted."); }
}

export class Semaphore {
  private waiting: Array<() => void> = [];
  constructor(private available: number) {}
  get busy() { return this.available === 0; }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available--;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.available++;
    }
  }
}

export class JobRunner {
  private queue: QueueItem[] = [];
  private active = 0;
  private stopped = false;
  private criticalSections = 0;
  readonly busyIds = new Set<string>();
  // One CPU-heavy step at a time (FFmpeg conversion, YAMNet, waveform decode): the host has a single vCPU.
  readonly cpu = new Semaphore(1);
  // Recap generation is network-bound but token-hungry; two at once stays well inside the deployment's rate limit.
  readonly recapSlots = new Semaphore(2);
  // Set by the server: queued work for suspended/removed owners must not keep spending Azure money.
  canProcess: (id: string) => boolean = () => true;
  // Set by the server: charges decoded audio beyond the declared duration to the owner's quota (throws when over).
  chargeExtraAudio: (id: string, extraMs: number) => void = () => {};
  // Set by the server: builds and caches the clip editor's waveform for a session's original recording.
  buildWaveform: (id: string) => Promise<void> = async () => {};
  // Set by the server: called after a session's work stops (finishes pending deletions).
  afterRun: (id: string) => void = () => {};
  // Set by the server: the session owner's names list and whether known misspellings are fixed automatically.
  nameList: (id: string) => { entries: NameEntry[]; autoApply: boolean } = () => ({ entries: [], autoApply: false });
  private cancellations = new Map<string, AbortController>();
  private reserved = new Set<string>();
  // Learned stage durations; the server points this at DATA_DIR so estimates improve over time.
  timings = new StageTimings();
  private stepStarts = new Map<string, number>();
  constructor(
    private store: JobStore,
    private speech = new AzureSpeech(),
    private recap = generateRecap,
    private laughter: LaughterDetection = new LaughterDetector(),
    private suggestNames: SuggestCaller = callSuggestModel,
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

  enqueueNames(id: string) {
    this.enqueueOperation(id, "names");
  }

  private enqueueOperation(id: string, operation: QueueItem["operation"]) {
    if (this.reserved.has(id)) this.reserved.delete(id);
    else if (this.busyIds.has(id)) throw new Error("Job is already processing.");
    this.busyIds.add(id);
    this.queue.push({ id, operation });
    this.pump();
  }

  private pump() {
    while (!this.stopped && this.active < MAX_ACTIVE_JOBS && this.queue.length) {
      const { id, operation } = this.queue.shift()!;
      this.active++;
      void (async () => {
        try {
          if (operation === "laughter") await this.processLaughter(id);
          else if (operation === "names") await this.processNames(id);
          else await this.process(id, operation === "recap");
        } catch (error) {
          console.error(`Session ${id} processing stopped unexpectedly; check disk access and restart if it persists.`, error);
        } finally {
          this.busyIds.delete(id);
          this.cancellations.delete(id);
          this.active--;
          try { this.afterRun(id); } catch (error) { console.error(`After-run handling for session ${id} failed:`, error); }
          this.pump();
        }
      })();
    }
  }

  // Atomic against the latest saved state: parallel branches of one session must not overwrite each other.
  private async update(id: string, patch: Partial<Job>) {
    return this.store.mutate(id, () => patch);
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
    return this.store.mutate(id, job => {
      const progress = job.progress;
      if (!progress?.steps.some(step => step.key === key)) return jobPatch;
      return { ...jobPatch, progress: { ...progress, steps: progress.steps.map(step => step.key === key ? { ...step, ...patch } : step) } };
    });
  }
  private async startStep(id: string, key: ProgressStepKey, jobPatch: Partial<Job> = {}) {
    if (key !== "cleanup") this.checkCancelled(id);
    const resumed = this.hasStep(id, key, "running");
    // A step that was already running before a restart keeps its start time but is not used for timing stats.
    if (!resumed) this.stepStarts.set(`${id}:${key}`, Date.now());
    return this.stepUpdate(id, key, resumed ? {} : { status: "running", startedAt: new Date().toISOString(),
      endedAt: undefined, detail: undefined, fraction: undefined }, jobPatch);
  }
  private async endStep(id: string, key: ProgressStepKey, status: "done" | "failed" | "skipped", jobPatch: Partial<Job> = {}, detail?: string) {
    const started = this.stepStarts.get(`${id}:${key}`);
    this.stepStarts.delete(`${id}:${key}`);
    if (status === "done" && started !== undefined) {
      const elapsedMs = Date.now() - started;
      const audioMs = this.store.get(id)?.durationMs ?? 0;
      console.log(`Session ${id}: "${STEP_LABELS[key]}" took ${(elapsedMs / 1000).toFixed(1)} s for ${(audioMs / 60_000).toFixed(1)} min of audio.`);
      await this.timings.record(key, elapsedMs, audioMs);
    }
    return this.stepUpdate(id, key, { status, endedAt: new Date().toISOString(),
      ...(status === "done" ? { fraction: 1, detail: undefined } : {}), ...(detail ? { detail } : {}) }, jobPatch);
  }
  private async finishRun(id: string, outcome: "completed" | "failed") {
    await this.store.mutate(id, job => {
      const progress = job.progress;
      if (!progress || progress.finishedAt) return {};
      const now = new Date().toISOString();
      const steps = progress.steps.map(step => step.status === "running"
        ? { ...step, status: outcome === "failed" ? "failed" as const : "done" as const, endedAt: now } : step);
      return { progress: { ...progress, steps, finishedAt: now, outcome } };
    });
  }

  // Runs a CPU-heavy step when the CPU is free, telling the user if it is waiting behind another session.
  private async withCpu<T>(id: string, key: ProgressStepKey, work: () => Promise<T>): Promise<T> {
    if (this.cpu.busy) await this.stepUpdate(id, key, { detail: "Waiting for another session's audio work to finish" });
    return this.cpu.run(work);
  }

  // Stop taking new work. In-flight work is abandoned at process exit and resumed from persisted state.
  stop() { this.stopped = true; }

  // Stops a session's work as soon as possible (kills local tools, abandons the Speech wait); cleanup still runs.
  cancel(id: string): boolean {
    if (!this.busyIds.has(id)) return false;
    const queued = this.queue.findIndex(item => item.id === id);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.busyIds.delete(id);
      try { this.afterRun(id); } catch (error) { console.error(`After-run handling for session ${id} failed:`, error); }
      return true;
    }
    this.signal(id);
    this.cancellations.get(id)!.abort();
    return true;
  }
  private signal(id: string) {
    let controller = this.cancellations.get(id);
    if (!controller) { controller = new AbortController(); this.cancellations.set(id, controller); }
    return controller.signal;
  }
  private checkCancelled(id: string) {
    if (this.cancellations.get(id)?.signal.aborted) throw new CancelledError();
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
    const id = job.id;
    return this.withCpu(id, "laughter", async () => {
      const started = await this.startStep(id, "laughter", {
        ...(updateStage ? { stage: "Detecting laughter with YAMNet" } : {}),
        laughter: { ...job.laughter, status: "running", error: undefined },
      });
      try {
        const result = await this.laughter.detect(this.store.audioPath(id), durationMs, this.signal(id));
        return this.endStep(id, "laughter", "done", {
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
        console.error(`Laughter detection for job ${id} failed: ${message}`);
        return this.endStep(id, "laughter", "failed", {
          laughter: { ...started.laughter, status: "failed", events: started.laughter.events, error: message },
        });
      }
    });
  }

  private async waveformStep(id: string) {
    if (!this.hasStep(id, "waveform", "pending", "running")) return;
    const job = this.store.get(id);
    if (!job || !recordingAvailable(job) || !job.durationMs) {
      await this.endStep(id, "waveform", "skipped");
      return;
    }
    await this.withCpu(id, "waveform", async () => {
      await this.startStep(id, "waveform");
      try {
        await this.buildWaveform(id);
        await this.endStep(id, "waveform", "done");
      } catch (error) {
        console.error(`Waveform for session ${id} failed: ${error instanceof Error ? error.message : error}`);
        await this.endStep(id, "waveform", "failed", {}, "Will be built when you open the clip editor");
      }
    });
  }

  // Local work that doesn't depend on the transcript runs while Azure transcribes: laughter, then the waveform.
  private async sideWork(id: string) {
    try {
      if (this.hasStep(id, "laughter", "pending", "running")) await this.detectLaughter(this.store.get(id)!, false);
      await this.waveformStep(id);
    } catch (error) {
      console.error(`Background analysis for session ${id} failed:`, error instanceof Error ? error.message : error);
    }
  }

  private async processLaughter(id: string) {
    if (!this.store.get(id)) throw new Error("Processing job disappeared.");
    const job = await this.plan(id, "laughter", [["laughter", false]]);
    const result = await this.detectLaughter(job, false);
    await this.finishRun(id, result.laughter.status === "failed" ? "failed" : "completed");
  }

  // Proposes fixes for misheard names; the owner reviews them before anything changes in the transcript.
  private async processNames(id: string) {
    let outcome: "completed" | "failed" = "completed";
    try {
      await this.plan(id, "names", [["names", false]]);
      if (!this.canProcess(id)) throw new Error("The session owner's account is no longer active, so processing stopped.");
      if (readiness().recapMissing.length) throw new Error("Configure Azure OpenAI to check names.");
      const job = await this.startStep(id, "names", { status: "checking_names", stage: "Looking for misheard names", error: undefined });
      if (this.recapSlots.busy) await this.stepUpdate(id, "names", { detail: "Waiting for a recap to finish" });
      const suggestions = await this.recapSlots.run(() => suggestNameFixes(job, this.nameList(id).entries, async (done, total) => {
        this.checkCancelled(id);
        await this.stepUpdate(id, "names", { detail: `Checked ${done} of ${total} parts`, fraction: total ? done / total : 0 });
      }, this.suggestNames, this.signal(id)));
      this.checkCancelled(id);
      const count = suggestions.items.length;
      await this.endStep(id, "names", "done", {
        nameSuggestions: suggestions, queuedOperation: undefined,
        status: job.recap ? "completed" : "transcript_ready",
        stage: count ? `${count} suggested name fix${count === 1 ? "" : "es"} to review` : "No misheard names found",
      }, count ? `${count} to review` : "Nothing to fix");
    } catch (error) {
      outcome = "failed";
      const message = this.cancellations.get(id)?.signal.aborted ? new CancelledError().message :
        error instanceof Error ? error.message : "Unexpected name-check failure.";
      console.error(`Name check for session ${id} failed: ${message}`);
      if (this.hasStep(id, "names", "running", "pending")) await this.endStep(id, "names", "failed", {}, "Stopped with an error");
      await this.store.mutate(id, current => ({
        status: current.recap ? "completed" : current.segments.length ? "transcript_ready" : "failed",
        stage: "Name check failed; the transcript is unchanged", error: message, queuedOperation: undefined,
      }));
    } finally {
      await this.finishRun(id, outcome);
    }
  }

  private async process(id: string, recapOnly = false) {
    let job = this.store.get(id)!;
    let outcome: "completed" | "failed" = "completed";
    let side: Promise<void> | undefined;
    try {
      const transcribed = job.segments.length > 0;
      const submitted = transcribed || !!job.speechJobUrl;
      const laughterSettled = job.demo || !this.laughter.enabled ||
        job.laughter.status === "completed" || job.laughter.status === "skipped";
      job = recapOnly ? await this.plan(id, "recap", [["recap", false]]) : await this.plan(id, "process", [
        ["prepare", submitted], ["upload", submitted], ["submit", submitted],
        ["laughter", transcribed || laughterSettled], ["waveform", transcribed], ["transcribe", transcribed],
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
          job = await this.withCpu(id, "prepare", async () => {
            let current = await this.startStep(id, "prepare", { status: "normalizing", stage: "Checking recording and mixing to mono for diarization", error: undefined });
            const durationMs = await inspectRecording(config.ffprobe, this.store.audioPath(id), current.originalName);
            current = await this.update(id, { durationMs, audioRetained: true });
            await normalizeAudio(config.ffmpeg, this.store.audioPath(id), this.store.monoPath(id), MAX_TRANSCRIPTION_MS + 60_000, this.signal(id), config.speechInputLeveling);
            this.checkCancelled(id);
            // Container metadata can understate length; bill and bound the audio Speech will actually receive.
            const decodedMs = await inspectDecodedDuration(config.ffprobe, this.store.monoPath(id));
            if (decodedMs > MAX_TRANSCRIPTION_MS + 30_000) {
              throw new Error("This recording exceeds Azure batch diarization's 4-hour limit. Split it manually; speaker labels will not carry across files.");
            }
            if (decodedMs > durationMs + DURATION_TOLERANCE_MS) this.chargeExtraAudio(id, decodedMs - durationMs);
            return this.endStep(id, "prepare", "done", { durationMs: Math.max(durationMs, decodedMs) });
          });
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
        side = this.sideWork(id);
        job = await this.startStep(id, "transcribe", { status: "transcribing" });
        const result = await this.speech.waitForTranscript(job.speechJobUrl!, async status => {
          this.checkCancelled(id);
          await this.stepUpdate(id, "transcribe", { detail: status === "NotStarted" ? "Waiting in Azure's queue" : "Azure is transcribing" },
            { status: "transcribing", stage: `Azure Speech: ${status}. Batch processing can take minutes to hours.` });
        });
        // Known misspellings from the owner's names list are fixed before anything (the recap included) reads the transcript.
        const names = this.nameList(id);
        const fixed = names.autoApply ? applyNameList(result.segments, names.entries) : { segments: result.segments, count: 0 };
        job = await this.endStep(id, "transcribe", "done", {
          status: "transcript_ready", stage: "Transcript saved",
          segments: fixed.segments, warnings: [...this.store.get(id)!.warnings, ...result.warnings],
        }, fixed.count ? `Fixed ${fixed.count} listed name${fixed.count === 1 ? "" : "s"}` : undefined);
      }
      if (readiness().recapMissing.length) throw new Error("Transcript is ready. Configure Azure OpenAI to generate its recap.");
      if (this.recapSlots.busy) await this.stepUpdate(id, "recap", { detail: "Waiting for another recap to finish" });
      job = await this.recapSlots.run(async () => {
        const current = await this.startStep(id, "recap", { status: "summarizing", stage: "Preparing evidence-grounded recap", error: undefined });
        const recap = await this.recap(current, async stage => {
          this.checkCancelled(id);
          const fraction = recapFraction(stage);
          await this.stepUpdate(id, "recap", { detail: stage, ...(fraction === undefined ? {} : { fraction }) }, { stage });
        }, undefined, this.nameList(id).entries.map(entry => entry.term));
        return this.endStep(id, "recap", "done", { recap, recapStale: false, status: "completed", stage: "Transcript and recap ready", queuedOperation: undefined });
      });
    } catch (error) {
      outcome = "failed";
      const message = this.cancellations.get(id)?.signal.aborted ? new CancelledError().message :
        error instanceof Error ? error.message : "Unexpected processing failure.";
      console.error(`Job ${id} failed: ${message}`);
      job = await this.store.mutate(id, current => ({
        status: current.segments.length ? "transcript_ready" : "failed",
        stage: current.segments.length ? "Transcript saved; recap requires attention" : "Processing failed",
        error: message, queuedOperation: undefined,
      }));
    } finally {
      // Laughter and waveform results are independent of the transcript; let them finish before cleaning up.
      await side;
      // A step that was still running when processing failed is the one that failed.
      const running = this.store.get(id)?.progress?.steps.find(step => step.status === "running" && step.key !== "cleanup");
      if (running) await this.endStep(id, running.key, outcome === "failed" ? "failed" : "done");
      if (this.hasStep(id, "cleanup", "pending", "running")) await this.startStep(id, "cleanup");
      const warnings = await this.speech.cleanup(this.store.get(id) ?? job);
      for (const file of [this.store.monoPath(id)]) {
        try { await rm(file, { force: true }); }
        catch { warnings.push("Could not delete normalized local audio. Remove mono.mp3 manually from this job's data directory."); }
      }
      if (warnings.length) {
        console.warn(`Job ${id} cleanup warnings: ${warnings.join(" ")}`);
        await this.store.mutate(id, current => ({ warnings: [...current.warnings, ...warnings] }));
      }
      // Keep failed cleanup handles for deletion retries, but not successful ones.
      if (!warnings.length) await this.update(id, { speechJobUrl: undefined, blobName: undefined });
      if (this.hasStep(id, "cleanup", "running")) await this.endStep(id, "cleanup", "done");
      await this.finishRun(id, outcome);
    }
  }
}
