import { rm } from "node:fs/promises";
import path from "node:path";
import { recordingExpiry, type Job } from "./domain.js";
import type { JobStore } from "./store.js";

export interface RetentionOptions {
  retentionDays: number;
  // Jobs with in-flight work (processing, waveform, export) are skipped and retried next sweep.
  isBusy: (id: string) => boolean;
  now?: () => number;
}

export class RetentionSweeper {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(private store: JobStore, private options: RetentionOptions) {}

  start(intervalMs = 10 * 60_000) {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  sweep(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run() {
    const now = this.options.now?.() ?? Date.now();
    for (const job of this.store.list()) {
      try { await this.reconcile(job, now); }
      catch (error) {
        console.error(`Recording retention for session ${job.id} failed; it will be retried.`,
          error instanceof Error ? error.message : error);
      }
    }
  }

  private async reconcile(job: Job, now: number) {
    if (job.demo || !job.audioRetained) return;
    if (!job.recordingExpiresAt) {
      // Backfill sessions accepted before retention existed: their accepted-upload time is createdAt.
      const expiresAt = recordingExpiry(job.recordingUploadedAt ?? job.createdAt, this.options.retentionDays);
      if (!expiresAt) return;
      job = await this.store.save({ ...job, recordingUploadedAt: job.recordingUploadedAt ?? job.createdAt, recordingExpiresAt: expiresAt });
    }
    if (Date.parse(job.recordingExpiresAt!) > now || this.options.isBusy(job.id)) return;
    await purgeRecordingFiles(this.store, job.id);
    const current = this.store.get(job.id);
    if (!current) return;
    await this.store.save({ ...current, audioRetained: false, recordingPurgedAt: new Date(now).toISOString() });
    console.log(`Session ${job.id}: original recording removed after its retention period.`);
  }
}

export async function purgeRecordingFiles(store: JobStore, id: string) {
  const directory = store.directory(id);
  for (const file of [store.audioPath(id), store.monoPath(id), path.join(directory, "waveform-v1.bin")]) {
    await rm(file, { force: true });
  }
}
