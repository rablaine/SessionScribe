import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const lockSchema = z.object({ id: z.string(), host: z.string(), heartbeatAt: z.number() });
type LockRecord = z.infer<typeof lockSchema>;

export interface InstanceLockOptions {
  staleMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  host?: string;
  onLost?: () => void;
  log?: (message: string) => void;
}

/**
 * Single-writer guard for DATA_DIR. SQLite on a network share and the process-local job queue are only
 * safe with one active process. During a rolling deploy the new instance waits here until the old one
 * releases the lock on shutdown (or its heartbeat goes stale after a crash).
 */
export class InstanceLock {
  readonly id = randomUUID();
  private readonly file: string;
  private readonly staleMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly host: string;
  private timer?: NodeJS.Timeout;
  private held = false;
  private lastHeartbeat = 0;

  constructor(directory: string, private options: InstanceLockOptions = {}) {
    this.file = path.join(directory, ".instance.lock");
    this.staleMs = options.staleMs ?? 45_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.pollMs = options.pollMs ?? 3_000;
    this.host = options.host ?? os.hostname();
  }

  private async read(): Promise<LockRecord | undefined> {
    try { return lockSchema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch { return undefined; }
  }
  private async write() {
    const temporary = `${this.file}.${this.id}.tmp`;
    await writeFile(temporary, JSON.stringify({ id: this.id, host: this.host, heartbeatAt: Date.now() }));
    await rename(temporary, this.file);
  }

  async acquire(): Promise<void> {
    let announced = false;
    for (;;) {
      const current = await this.read();
      // A restarted container keeps its hostname, so its own previous lock is reclaimed immediately.
      if (!current || current.id === this.id || current.host === this.host || Date.now() - current.heartbeatAt > this.staleMs) {
        await this.write();
        await delay(Math.min(1000, this.pollMs));
        if ((await this.read())?.id === this.id) break;
      } else if (!announced) {
        this.options.log?.("Waiting for the previous instance to release the data directory...");
        announced = true;
      }
      await delay(this.pollMs);
    }
    this.held = true;
    this.lastHeartbeat = Date.now();
    this.timer = setInterval(() => void this.heartbeat(), this.heartbeatMs);
  }

  private async heartbeat() {
    if (!this.held) return;
    const current = await this.read();
    if (current && current.id !== this.id) {
      this.held = false;
      if (this.timer) clearInterval(this.timer);
      this.options.onLost?.();
      return;
    }
    try {
      await this.write();
      this.lastHeartbeat = Date.now();
    } catch (error) {
      this.options.log?.(`Instance lock heartbeat failed: ${error instanceof Error ? error.message : error}`);
      // Once our heartbeat looks stale to others, another instance may take over: stop writing immediately.
      if (Date.now() - this.lastHeartbeat > this.staleMs - this.heartbeatMs) {
        this.held = false;
        if (this.timer) clearInterval(this.timer);
        this.options.onLost?.();
      }
    }
  }

  async release() {
    if (this.timer) clearInterval(this.timer);
    if (!this.held) return;
    this.held = false;
    if ((await this.read())?.id === this.id) await rm(this.file, { force: true });
  }
}
