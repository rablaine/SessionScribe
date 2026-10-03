import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProgressStepKey } from "./domain.js";

// Starting guesses (before any history exists): fixed cost plus cost per minute of audio.
// Learned medians replace the per-minute part once real runs have been recorded.
const DEFAULTS: Record<ProgressStepKey, { baseMs: number; perAudioMinuteMs: number }> = {
  prepare: { baseMs: 3_000, perAudioMinuteMs: 600 },
  upload: { baseMs: 2_000, perAudioMinuteMs: 150 },
  submit: { baseMs: 3_000, perAudioMinuteMs: 0 },
  laughter: { baseMs: 10_000, perAudioMinuteMs: 1_500 },
  waveform: { baseMs: 3_000, perAudioMinuteMs: 400 },
  transcribe: { baseMs: 60_000, perAudioMinuteMs: 12_000 },
  recap: { baseMs: 20_000, perAudioMinuteMs: 3_000 },
  cleanup: { baseMs: 2_000, perAudioMinuteMs: 0 },
};
const SAMPLES = 25;

type History = Partial<Record<ProgressStepKey, number[]>>;

/**
 * Records how long each processing stage takes relative to recording length, and estimates future
 * stages from the median of recent runs. Stored as a small JSON file in DATA_DIR (single writer).
 */
export class StageTimings {
  private history: History = {};
  private loaded?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  constructor(private file?: string) {}

  static inDirectory(directory: string) { return new StageTimings(path.join(directory, "stage-timings.json")); }

  private async load() {
    if (!this.file) return;
    this.loaded ??= readFile(this.file, "utf8").then(text => {
      const parsed = JSON.parse(text) as History;
      for (const key of Object.keys(DEFAULTS) as ProgressStepKey[]) {
        const values = parsed[key];
        if (Array.isArray(values)) this.history[key] = values.filter(value => Number.isFinite(value) && value >= 0).slice(-SAMPLES);
      }
    }).catch(() => {});
    await this.loaded;
  }

  async estimate(key: ProgressStepKey, audioMs: number): Promise<number> {
    await this.load();
    const minutes = Math.max(audioMs, 60_000) / 60_000;
    const { baseMs, perAudioMinuteMs } = DEFAULTS[key];
    const samples = this.history[key];
    if (!samples?.length) return Math.round(baseMs + perAudioMinuteMs * minutes);
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    // Fixed-cost stages store raw durations; scaling stages store the per-minute cost above the fixed base,
    // so short test clips (dominated by queue/startup overhead) don't inflate estimates for long sessions.
    return Math.round(perAudioMinuteMs === 0 ? median : baseMs + median * minutes);
  }

  async record(key: ProgressStepKey, elapsedMs: number, audioMs: number) {
    await this.load();
    const minutes = Math.max(audioMs, 60_000) / 60_000;
    const { baseMs, perAudioMinuteMs } = DEFAULTS[key];
    const value = perAudioMinuteMs === 0 ? elapsedMs : Math.max(0, elapsedMs - baseMs) / minutes;
    this.history[key] = [...(this.history[key] ?? []), Math.round(value)].slice(-SAMPLES);
    if (!this.file) return;
    const file = this.file;
    const snapshot = JSON.stringify(this.history);
    this.writing = this.writing.then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, file);
    }).catch(error => console.warn("Could not save stage timings:", error instanceof Error ? error.message : error));
    await this.writing;
  }
}
