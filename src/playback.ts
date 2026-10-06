import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./audio.js";

// Four hours at 192 kbps, plus metadata/padding; never trust VBR source bytes to predict CBR size.
export const MAX_PLAYBACK_BYTES = 4 * 60 * 60 * 24_000 + 1024 * 1024;
const PLAYBACK_HEADROOM = 64 * 1024;

export function validatePlaybackSize(size: number) {
  if (size <= 0 || size >= MAX_PLAYBACK_BYTES - PLAYBACK_HEADROOM) {
    throw new Error("Playback output is empty or exceeds its storage limit. The original recording is unchanged.");
  }
}

export async function removePlaybackTemporaries(output: string) {
  const directory = path.dirname(output);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^playback-v[12]\.mp3\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) {
      await rm(path.join(directory, entry.name), { force: true });
    }
  }
}

export class PlaybackAudio {
  private pending = new Map<string, Promise<void>>();
  private failures = new Map<string, Error>();
  private reservedBytes = 0;
  private controllers = new Map<string, AbortController>();
  private stopped = false;
  constructor(private executable: string, private minFreeBytes = 0) {}
  isGenerating(id: string) { return this.pending.has(id); }
  forget(id: string) { this.failures.delete(id); }
  async stop() {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.pending.values());
  }

  async prepare(id: string, input: string, output: string, waitMs = 25): Promise<boolean> {
    if (this.stopped) throw new Error("Playback preparation is stopping. Try again after the server restarts.");
    const failure = this.failures.get(id);
    if (failure) {
      this.failures.delete(id);
      throw failure;
    }
    let work = this.pending.get(id);
    if (!work) {
      if (this.pending.size >= 2) {
        throw Object.assign(new Error("Playback preparation is busy. Try again shortly."), { status: 429 });
      }
      const controller = new AbortController();
      this.controllers.set(id, controller);
      work = this.ensure(input, output, controller.signal);
      this.pending.set(id, work);
      const created = work;
      created.then(() => {}, error => {
        const failure = error instanceof Error ? error : new Error("Playback preparation failed.");
        this.failures.set(id, failure);
        console.error(`Playback preparation for session ${id} failed: ${failure.message}`);
      }).finally(() => {
        if (this.pending.get(id) === created) this.pending.delete(id);
        if (this.controllers.get(id) === controller) this.controllers.delete(id);
      });
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([work.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), waitMs); })]);
    } catch (error) {
      this.failures.delete(id);
      throw error;
    } finally { clearTimeout(timer); }
  }

  private async ensure(input: string, output: string, signal: AbortSignal) {
    const source = await stat(input);
    signal.throwIfAborted();
    await removePlaybackTemporaries(output);
    signal.throwIfAborted();
    try {
      const cached = await stat(output);
      if (cached.size > 0 && cached.mtimeMs >= source.mtimeMs) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const reservation = MAX_PLAYBACK_BYTES + PLAYBACK_HEADROOM;
    this.reservedBytes += reservation;
    try {
      const disk = await statfs(path.dirname(output));
      if (disk.bavail * disk.bsize < this.reservedBytes + this.minFreeBytes) {
        throw Object.assign(new Error("There is not enough free storage for accurate playback. Try again later or download the original."), { status: 507 });
      }
      await this.encode(input, output, signal);
    } finally { this.reservedBytes -= reservation; }
  }

  private async encode(input: string, output: string, signal: AbortSignal) {
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      await runTool(this.executable, ["-nostdin", "-v", "error", "-y", "-i", input, "-map", "0:a:0",
        "-codec:a", "libmp3lame", "-b:a", "192k", "-threads", "1", "-write_xing", "1",
        "-fs", String(MAX_PLAYBACK_BYTES), "-f", "mp3", temporary], 30 * 60_000, signal);
      validatePlaybackSize((await stat(temporary)).size);
      signal.throwIfAborted();
      await rename(temporary, output);
      await rm(path.join(path.dirname(output), "playback-v1.mp3"), { force: true });
    } finally { await rm(temporary, { force: true }); }
  }
}
