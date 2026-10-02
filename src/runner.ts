import { rm } from "node:fs/promises";
import { config, readiness } from "./config.js";
import { inspectRecording, normalizeAudio } from "./audio.js";
import { AzureSpeech } from "./azure.js";
import type { Job } from "./domain.js";
import { generateRecap } from "./recap.js";
import { JobStore } from "./store.js";
import { LaughterDetector, type LaughterDetection } from "./laughter.js";

export const activeStatuses = new Set(["queued", "normalizing", "uploading", "transcribing", "summarizing"]);
export const activeLaughterStatuses = new Set(["queued", "running"]);
type QueueItem = { id: string; operation: "process" | "laughter" };

export class JobRunner {
  private queue: QueueItem[] = [];
  private running = false;
  readonly busyIds = new Set<string>();
  constructor(
    private store: JobStore,
    private speech = new AzureSpeech(),
    private recap = generateRecap,
    private laughter: LaughterDetection = new LaughterDetector(),
  ) {}

  enqueue(id: string) {
    this.enqueueOperation(id, "process");
  }

  enqueueLaughter(id: string) {
    this.enqueueOperation(id, "laughter");
  }

  private enqueueOperation(id: string, operation: QueueItem["operation"]) {
    if (this.busyIds.has(id)) throw new Error("Job is already processing.");
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

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const { id, operation } = this.queue.shift()!;
        try {
          if (operation === "laughter") await this.processLaughter(id);
          else await this.process(id);
        } finally {
          this.busyIds.delete(id);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async detectLaughter(job: Job, updateStage: boolean): Promise<Job> {
    if (job.demo || job.laughter.status === "completed" || job.laughter.status === "skipped") return job;
    if (!this.laughter.enabled) {
      return this.update(job.id, {
        laughter: { status: "skipped", events: [], error: "Laughter detection is disabled." },
      });
    }
    if (!job.audioRetained || !job.durationMs) {
      return this.update(job.id, {
        laughter: { status: "failed", events: [], error: "A retained recording with a known duration is required." },
      });
    }
    const durationMs = job.durationMs;
    job = await this.update(job.id, {
      ...(updateStage ? { stage: "Detecting laughter with YAMNet" } : {}),
      laughter: { ...job.laughter, status: "running", error: undefined },
    });
    try {
      const result = await this.laughter.detect(this.store.audioPath(job.id), durationMs);
      return this.update(job.id, {
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
      return this.update(job.id, {
        laughter: { ...job.laughter, status: "failed", events: job.laughter.events, error: message },
      });
    }
  }

  private async processLaughter(id: string) {
    const job = this.store.get(id);
    if (!job) throw new Error("Processing job disappeared.");
    await this.detectLaughter(job, false);
  }

  private async process(id: string) {
    let job = this.store.get(id)!;
    try {
      if (!job.segments.length) {
        if (readiness().transcriptionMissing.length) throw new Error("Azure Speech/Storage configuration is incomplete.");
        if (!job.speechJobUrl) {
          job = await this.update(id, { status: "normalizing", stage: "Checking recording and mixing to mono for diarization", error: undefined });
          const durationMs = await inspectRecording(config.ffprobe, this.store.audioPath(id), job.originalName);
          job = await this.update(id, { durationMs, audioRetained: true });
          await normalizeAudio(config.ffmpeg, this.store.audioPath(id), this.store.monoPath(id));
          job = await this.update(id, { status: "uploading", stage: "Uploading to private Azure Blob Storage", blobName: `${id}/mono.mp3` });
          const audioUrl = await this.speech.upload(this.store.monoPath(id), job.blobName!);
          const speechJobUrl = await this.speech.submit(job, audioUrl);
          job = await this.update(id, { speechJobUrl, status: "transcribing", stage: "Azure Speech job submitted" });
        }
        job = await this.detectLaughter(job, true);
        const result = await this.speech.waitForTranscript(job.speechJobUrl!, async status => {
          await this.update(id, { status: "transcribing", stage: `Azure Speech: ${status}. Batch processing can take minutes to hours.` });
        });
        job = await this.update(id, {
          status: "transcript_ready", stage: "Transcript saved",
          segments: result.segments, warnings: [...job.warnings, ...result.warnings],
        });
      }
      if (readiness().recapMissing.length) throw new Error("Transcript is ready. Configure Azure OpenAI to generate its recap.");
      job = await this.update(id, { status: "summarizing", stage: "Preparing evidence-grounded recap", error: undefined });
      const recap = await this.recap(job, async stage => { await this.update(id, { stage }); });
      job = await this.update(id, { recap, recapStale: false, status: "completed", stage: "Transcript and recap ready" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected processing failure.";
      console.error(`Job ${id} failed: ${message}`);
      job = await this.update(id, {
        status: this.store.get(id)!.segments.length ? "transcript_ready" : "failed",
        stage: this.store.get(id)!.segments.length ? "Transcript saved; recap requires attention" : "Processing failed",
        error: message,
      });
    } finally {
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
    }
  }
}
