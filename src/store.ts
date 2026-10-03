import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { jobSchema, type Job } from "./domain.js";

interface PersistenceOptions {
  rename?: (source: string, target: string) => Promise<void>;
  platform?: NodeJS.Platform;
  delay?: (milliseconds: number) => Promise<void>;
}

const renameRetryDelays = [50, 100, 200, 400, 800, 1600];

async function renameJobFile(source: string, target: string, options: PersistenceOptions) {
  for (let attempt = 0; ; attempt++) {
    try {
      await (options.rename ?? rename)(source, target);
      return;
    } catch (error) {
      const transientWindowsLock = (options.platform ?? process.platform) === "win32" &&
        error instanceof Error && "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
      const wait = renameRetryDelays[attempt];
      if (!transientWindowsLock || wait === undefined) throw error;
      await (options.delay ?? delay)(wait);
    }
  }
}

export class JobStore {
  private jobs = new Map<string, Job>();
  private writes = new Map<string, Promise<void>>();
  constructor(readonly root: string, private persistence: PersistenceOptions = {}) {}
  directory(id: string) { return path.join(this.root, id); }
  // Retain the historical filename for persisted jobs; ffprobe detects the actual container.
  audioPath(id: string) { return path.join(this.directory(id), "original.mp3"); }
  monoPath(id: string) { return path.join(this.directory(id), "mono.mp3"); }

  async init() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const job = jobSchema.parse(JSON.parse(await readFile(path.join(this.root, entry.name, "job.json"), "utf8")));
        if (job.id !== entry.name) throw new Error("Job ID does not match its directory.");
        this.jobs.set(job.id, job);
        let audioRetained = false;
        try {
          await access(this.audioPath(job.id));
          audioRetained = true;
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
        if (job.audioRetained !== audioRetained) await this.save({ ...job, audioRetained });
      } catch (error) {
        // An interrupted upload has no job.json; other corruption must not be hidden.
        if (isMissingFile(error)) {
          console.warn(`Ignoring incomplete upload directory ${entry.name}; remove it manually if unused.`);
        } else {
          throw new Error(`Cannot load persisted job ${entry.name}. Restore or remove that job directory.`, { cause: error });
        }
      }
    }
  }

  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string) { return this.jobs.get(id); }

  async save(job: Job) {
    const value = jobSchema.parse({ ...job, updatedAt: new Date().toISOString() });
    return this.serialize(job.id, () => this.write(value));
  }

  private async write(value: Job) {
    const directory = this.directory(value.id);
    const temporary = path.join(directory, `job.json.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
      await renameJobFile(temporary, path.join(directory, "job.json"), this.persistence);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch (cleanupError) {
        console.error(`Could not remove failed job persistence temporary file ${temporary}:`, cleanupError);
      }
      throw error;
    }
    this.jobs.set(value.id, value);
    return value;
  }

  // Read-modify-write against the latest saved state, serialized with other writes to the same job, so
  // concurrent workers on one session (e.g. transcription and laughter detection) never drop each other's changes.
  async mutate(id: string, change: (job: Job) => Partial<Job>): Promise<Job> {
    return this.serialize(id, async () => {
      const current = this.jobs.get(id);
      if (!current) throw new Error("Processing job disappeared.");
      return this.write(jobSchema.parse({ ...current, ...change(current), updatedAt: new Date().toISOString() }));
    });
  }

  async remove(id: string) {
    return this.serialize(id, async () => {
      if (!this.jobs.has(id)) throw new Error("Job not found.");
      await rm(this.directory(id), { recursive: true, force: false });
      this.jobs.delete(id);
    });
  }

  private async serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.writes.get(id) ?? Promise.resolve()).then(operation);
    // Settle only the queue tail; the original operation still rejects to its caller.
    const tail = result.then(() => {}, () => {});
    this.writes.set(id, tail);
    try {
      return await result;
    } finally {
      if (this.writes.get(id) === tail) this.writes.delete(id);
    }
  }
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
