import type { Express, Request } from "express";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { z } from "zod";
import { config, readiness } from "./config.js";
import { inspectRecording, recordingFormat } from "./audio.js";
import { jobSchema, publicJob, recordingExpiry } from "./domain.js";
import type { Accounts } from "./accounts.js";
import type { JobRunner } from "./runner.js";
import type { JobStore } from "./store.js";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const CHUNK_BYTES = 8 * 1024 * 1024;
const STALE_UPLOAD_MS = 6 * 60 * 60 * 1000;
const MAX_ACTIVE_UPLOADS = 3;

const startSchema = z.object({
  title: z.string().trim().min(1).max(200),
  locale: z.string().regex(/^[a-z]{2,3}-[A-Z]{2}$/).default("en-US"),
  maxSpeakers: z.coerce.number().int().min(2).max(35).default(8),
  context: z.string().max(6000).default(""),
  consent: z.literal(true),
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
}).strict();
const stateSchema = startSchema.omit({ consent: true }).extend({
  id: z.uuid(), ownerId: z.string().min(1), createdAt: z.string(), touchedAt: z.number(),
});
type UploadState = z.infer<typeof stateSchema>;

class UploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class Uploads {
  readonly root: string;
  private writing = new Set<string>();
  private admissions: Promise<unknown> = Promise.resolve();
  // Upload admission (per-user, global, and disk checks) runs one request at a time so parallel starts
  // cannot all observe the same free slot.
  private admit<T>(work: () => Promise<T>): Promise<T> {
    const result = this.admissions.then(work);
    this.admissions = result.catch(() => {});
    return result;
  }
  constructor(private store: JobStore, private runner: JobRunner, private accounts: Accounts) {
    this.root = path.join(store.root, "uploads");
  }

  private directory(id: string) { return path.join(this.root, id); }
  private file(id: string) { return path.join(this.directory(id), "original.mp3"); }

  private async read(id: string): Promise<UploadState | undefined> {
    if (!z.uuid().safeParse(id).success) return undefined;
    try { return stateSchema.parse(JSON.parse(await readFile(path.join(this.directory(id), "upload.json"), "utf8"))); }
    catch { return undefined; }
  }
  private async write(state: UploadState) {
    const target = path.join(this.directory(state.id), "upload.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), "utf8");
    await rename(temporary, target);
  }
  private async received(id: string) {
    try { return (await stat(this.file(id))).size; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0; throw error; }
  }
  private async owned(req: Request, userId: string) {
    const state = await this.read(String(req.params.id));
    if (!state || state.ownerId !== userId) throw new UploadError(404, "Upload not found. Start the import again.");
    return state;
  }

  async active(): Promise<UploadState[]> {
    let entries: string[];
    try { entries = await readdir(this.root); } catch { return []; }
    const states: UploadState[] = [];
    for (const entry of entries) {
      const state = await this.read(entry);
      if (state && Date.now() - state.touchedAt < STALE_UPLOAD_MS) states.push(state);
    }
    return states;
  }

  // Abandoned or interrupted uploads are removed; they never become sessions.
  async cleanup() {
    let entries: string[];
    try { entries = await readdir(this.root); } catch { return; }
    for (const entry of entries) {
      if (this.writing.has(entry)) continue;
      const state = await this.read(entry);
      let age = state ? Date.now() - state.touchedAt : Infinity;
      if (!state) {
        try { age = Date.now() - (await stat(this.directory(entry))).mtimeMs; } catch { continue; }
      }
      if (age >= STALE_UPLOAD_MS) await rm(this.directory(entry), { recursive: true, force: true });
    }
  }

  register(app: Express) {
    app.post("/api/uploads", async (req, res) => {
      const missing = readiness().transcriptionMissing;
      if (missing.length) throw new UploadError(503, `Configure ${missing.join(", ")} before uploading.`);
      const parsed = startSchema.safeParse(req.body);
      if (!parsed.success) throw new UploadError(400, "Invalid upload fields. Check title, language, speaker count, file size, and recording consent.");
      const input = parsed.data;
      if (!recordingFormat(input.filename)) throw new UploadError(400, "Only MP3 and Ogg Opus (.opus or .ogg) uploads are supported.");
      const ownerId = this.accounts.userId(req);
      const state = await this.admit(async () => {
        await this.cleanup();
        const active = await this.active();
        if (active.some(upload => upload.ownerId === ownerId)) {
          throw new UploadError(409, "Finish or cancel your current upload before starting another.");
        }
        if (active.length >= MAX_ACTIVE_UPLOADS || this.runner.busyIds.size >= 5) {
          throw new UploadError(429, "The server is busy with other uploads. Try again in a few minutes.");
        }
        const today = this.accounts.usageSince(ownerId, "upload", Date.now() - 86_400_000);
        if (today >= config.quotas.uploads) {
          throw new UploadError(429, `Daily upload limit reached (${config.quotas.uploads} per 24 hours). Try again later.`);
        }
        await mkdir(this.root, { recursive: true });
        const disk = await statfs(this.root);
        if (disk.bavail * disk.bsize < input.size + config.minFreeDiskBytes) {
          throw new UploadError(507, "The server does not have enough free storage for this recording right now.");
        }
        const { consent: _consent, ...fields } = input;
        const created: UploadState = { ...fields, id: randomUUID(), ownerId, createdAt: new Date().toISOString(), touchedAt: Date.now() };
        await mkdir(this.directory(created.id));
        await this.write(created);
        return created;
      });
      res.status(201).json({ id: state.id, chunkBytes: CHUNK_BYTES, received: 0, size: state.size });
    });

    app.get("/api/uploads/:id", async (req, res) => {
      const state = await this.owned(req, this.accounts.userId(req));
      res.json({ id: state.id, chunkBytes: CHUNK_BYTES, received: await this.received(state.id), size: state.size });
    });

    app.put("/api/uploads/:id/chunk", async (req, res) => {
      const state = await this.owned(req, this.accounts.userId(req));
      const offset = z.coerce.number().int().nonnegative().safeParse(req.query.offset);
      if (!offset.success) throw new UploadError(400, "Invalid chunk offset.");
      const declared = Number(req.get("content-length"));
      if (!req.is("application/octet-stream") || !Number.isInteger(declared) || declared <= 0 || declared > CHUNK_BYTES) {
        throw new UploadError(400, `Send chunks as application/octet-stream of at most ${CHUNK_BYTES} bytes.`);
      }
      if (this.writing.has(state.id)) throw new UploadError(409, "This upload is already receiving a chunk.");
      this.writing.add(state.id);
      try {
        const received = await this.received(state.id);
        if (offset.data !== received) {
          res.status(409).json({ error: "Chunk offset does not match the bytes already received.", received });
          return;
        }
        if (received + declared > state.size) throw new UploadError(400, "Chunk exceeds the declared file size.");
        const disk = await statfs(this.root);
        if (disk.bavail * disk.bsize < declared + config.minFreeDiskBytes) {
          throw new UploadError(507, "The server is out of free storage. Try again later.");
        }
        let count = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            count += chunk.length;
            callback(count > declared ? new UploadError(400, "Chunk is larger than declared.") : null, chunk);
          },
        });
        try {
          await pipeline(req, limiter, createWriteStream(this.file(state.id), { flags: "a" }));
        } catch (error) {
          // Roll a partial append back to the last whole-chunk boundary so the client can resume cleanly.
          await truncate(this.file(state.id), received).catch(() => {});
          throw error instanceof UploadError ? error : new UploadError(400, "Chunk upload was interrupted. Retry from the last confirmed position.");
        }
        if (count !== declared) {
          await truncate(this.file(state.id), received);
          throw new UploadError(400, "Chunk was shorter than declared.");
        }
        await this.write({ ...state, touchedAt: Date.now() });
        res.json({ received: received + count, size: state.size });
      } finally {
        this.writing.delete(state.id);
      }
    });

    app.delete("/api/uploads/:id", async (req, res) => {
      const state = await this.owned(req, this.accounts.userId(req));
      if (this.writing.has(state.id)) throw new UploadError(409, "Wait for the current chunk to finish.");
      await rm(this.directory(state.id), { recursive: true, force: true });
      res.status(204).end();
    });

    app.post("/api/uploads/:id/complete", async (req, res) => {
      const ownerId = this.accounts.userId(req);
      const state = await this.owned(req, ownerId);
      if (this.writing.has(state.id)) throw new UploadError(409, "Wait for the current chunk to finish.");
      this.writing.add(state.id);
      try {
        if (await this.received(state.id) !== state.size) throw new UploadError(409, "The upload is incomplete. Resume it before finishing.");
        let durationMs: number;
        try {
          durationMs = await inspectRecording(config.ffprobe, this.file(state.id), state.filename);
        } catch (error) {
          await rm(this.directory(state.id), { recursive: true, force: true });
          const message = error instanceof Error && /valid|4-hour|supported/.test(error.message) ? error.message : "The recording could not be read.";
          throw new UploadError(400, message);
        }
        if (!this.accounts.isActiveUser(ownerId)) throw new UploadError(403, "Your account no longer has access.");
        if (this.runner.busyIds.size >= 5) throw new UploadError(429, "The processing queue is full. Try finishing the import again in a few minutes.");
        this.accounts.consumeQuota(ownerId, "audio-ms", durationMs, config.quotas.audioMs,
          `Daily audio limit reached (${config.quotas.audioMs / 3_600_000} hours per 24 hours). Try again later.`);
        this.accounts.consumeQuota(ownerId, "upload", 1, config.quotas.uploads,
          `Daily upload limit reached (${config.quotas.uploads} per 24 hours). Try again later.`);
        const id = state.id;
        await rename(this.directory(id), this.store.directory(id));
        await rm(path.join(this.store.directory(id), "upload.json"), { force: true });
        const now = new Date().toISOString();
        this.accounts.assignJob(id, ownerId);
        try {
          const job = await this.store.save(jobSchema.parse({
            id, title: state.title, originalName: path.basename(state.filename), audioRetained: true,
            createdAt: now, updatedAt: now, status: "queued", stage: "Waiting in the processing queue",
            locale: state.locale, maxSpeakers: state.maxSpeakers, context: state.context, durationMs,
            recordingUploadedAt: now, recordingExpiresAt: recordingExpiry(now, config.retentionDays),
          }));
          this.runner.enqueue(id);
          res.status(202).json(publicJob(job));
        } catch (error) {
          if (!this.store.get(id)) {
            this.accounts.releaseJob(id);
            await rm(this.store.directory(id), { recursive: true, force: true });
          }
          throw error;
        }
      } finally {
        this.writing.delete(state.id);
      }
    });
  }
}

export function uploadErrorStatus(error: unknown): { status: number; message: string } | undefined {
  return error instanceof UploadError ? { status: error.status, message: error.message } : undefined;
}

