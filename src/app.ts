import express, { type Request, type Response, type NextFunction } from "express";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { config, readiness } from "./config.js";
import { createDemo } from "./demo.js";
import { displaySpeaker, publicJob, transcriptCharacters, recordingAvailable, recordingState, recapMarkdown, transcriptMarkdown, transcriptSrt, transcriptText } from "./domain.js";
import { activeStatuses, JobRunner } from "./runner.js";
import { JobStore } from "./store.js";
import { AzureSpeech } from "./azure.js";
import { clipFilename, extractAudioClip, recordingFormat } from "./audio.js";
import { AccountError, Accounts } from "./accounts.js";
import { uploadErrorStatus, Uploads } from "./uploads.js";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Waveforms } from "./waveform.js";

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));

export function createApp(store: JobStore, runner: JobRunner, accounts: Accounts) {
  const app = express();
  app.disable("x-powered-by");
  // Behind exactly N trusted proxies req.ip is the client address they observed; spoofed entries further left are ignored.
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  if (config.logForwarding) {
    app.use("/api/auth/login", (req, _res, next) => {
      const chain = (req.get("x-forwarded-for") ?? "").split(",").map(value => value.trim()).filter(Boolean);
      // Class plus a short one-way fingerprint per hop: enough to see which hop is stable, no addresses logged.
      const kind = (ip: string) => `${/^(::ffff:)?(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)|^(::1$|f[cd]|fe80)/i.test(ip) ? "private" :
        /^(::ffff:)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? "cgnat" : "public"}:${createHash("sha256").update(ip).digest("hex").slice(0, 6)}`;
      console.log(`Forwarding diagnostics: socket=${kind(req.socket.remoteAddress ?? "")} chain=[${chain.map(kind).join(", ")}] resolved=${kind(req.ip ?? "")}`);
      next();
    });
  }
  const publicUrl = config.publicOrigin ? new URL(config.publicOrigin) : undefined;
  app.use((req, res, next) => {
    const host = req.get("host");
    const origin = req.get("origin");
    const hostAllowed = !!host && (publicUrl ? host.toLowerCase() === publicUrl.host :
      /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host));
    if (!hostAllowed) {
      res.status(403).json({ error: publicUrl ? "Unknown host." : "Public hosting is not enabled. This service currently accepts localhost requests only." });
      return;
    }
    const expectedOrigins = publicUrl ? [publicUrl.origin] : [`http://${host}`, `https://${host}`];
    if ((origin && !expectedOrigins.includes(origin)) || req.get("sec-fetch-site") === "cross-site") {
      res.status(403).json({ error: "Cross-origin requests are not allowed." });
      return;
    }
    res.set({
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      ...(publicUrl?.protocol === "https:" ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
    });
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(accounts.sessionMiddleware);
  app.use("/api", accounts.router);
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", accounts.requireActive);
  app.use("/api/jobs/:id", (req, res, next) => {
    if (!accounts.ownsJob(accounts.userId(req), req.params.id!)) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    next();
  });
  const waveforms = new Waveforms(config.ffmpeg);
  app.get("/api/jobs/:id/waveform", async (req, res) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (!recordingAvailable(job) || !job.durationMs) {
      res.status(409).json({ error: "A retained recording with a known duration is required for a waveform." }); return;
    }
    const window = z.object({
      startMs: z.coerce.number().int().nonnegative(),
      endMs: z.coerce.number().int().positive(),
      bins: z.coerce.number().int().min(32).max(2048).default(1024),
    }).strict().refine(value => value.endMs > value.startMs && value.endMs <= job.durationMs!).parse(req.query);
    const data = await waveforms.window(job.id, store.audioPath(job.id), job.durationMs, window.startMs, window.endMs, window.bins);
    if (!accounts.isActiveUser(accounts.userId(req)) || !accounts.ownsJob(accounts.userId(req), job.id)) {
      res.status(403).json({ error: "Your account no longer has access." }); return;
    }
    if (!data) {
      // Still decoding a long recording in the background; the browser polls instead of holding the request open.
      res.status(202).set("Retry-After", "3").json({ status: "generating" });
      return;
    }
    res.json(data);
  });
  app.get("/api/config", (_req, res) => res.json(readiness()));
  app.get("/api/jobs", (req, res) => res.json(store.list()
    .filter(job => accounts.ownsJob(accounts.userId(req), job.id)).map(job => ({
    id: job.id, title: job.title, createdAt: job.createdAt, status: job.status, demo: job.demo, stage: job.stage,
  }))));
  app.get("/api/jobs/:id", (req, res) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    res.set("Cache-Control", "no-store").json(publicJob(job));
  });
  app.get("/api/jobs/:id/audio", (req, res, next) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (!recordingAvailable(job)) {
      const expired = recordingState(job) === "expired";
      res.status(expired ? 410 : 404).json({ error: expired
        ? "This recording was removed after its retention period. The transcript and recap are still available."
        : "No retained recording is available. Older recordings were deleted after processing; upload the recording again for playback." });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.type(recordingFormat(job.originalName) === "opus" ? "audio/ogg" : "audio/mpeg");
    if (req.query.download === "1") {
      const extension = recordingFormat(job.originalName) === "opus" ? path.extname(job.originalName).toLowerCase() : ".mp3";
      res.attachment(clipFilename(job.title || "recording", job.id).replace(/\.mp3$/, extension));
    }
    res.sendFile(path.resolve(store.audioPath(job.id)), { acceptRanges: true, cacheControl: false }, error => {
      // Players routinely cancel range requests while seeking; that is not a server error.
      if (error && !(error.message === "Request aborted" || "code" in error && error.code === "ECONNABORTED")) next(error);
    });
  });
  app.get("/api/jobs/:id/clips", (req, res) => {
    if (!store.get(req.params.id!)) { res.status(404).json({ error: "Session not found." }); return; }
    res.json(accounts.listClips(req.params.id!));
  });
  app.post("/api/jobs/:id/laughter", async (req, res) => {
    let job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (!config.laughterEnabled) {
      res.status(503).json({ error: "Laughter detection is disabled on this server." }); return;
    }
    if (job.demo) { res.status(400).json({ error: "The fictional demo has no recording to analyze." }); return; }
    if (!recordingAvailable(job) || !job.durationMs) {
      res.status(409).json({ error: "A retained recording with a known duration is required." }); return;
    }
    if (runner.busyIds.has(job.id)) {
      res.status(409).json({ error: "This session is already processing." }); return;
    }
    accounts.consumeQuota(accounts.userId(req), "laughter", 1, config.quotas.laughter,
      `Daily laughter-detection limit reached (${config.quotas.laughter} per 24 hours). Try again later.`);
    job = await store.save({ ...job, laughter: { ...job.laughter, status: "queued", error: undefined } });
    runner.enqueueLaughter(job.id);
    res.status(202).json(publicJob(job));
  });
  const clipRange = z.object({
    name: z.string().trim().max(120).regex(/^[^\u0000-\u001f\u007f]*$/, "Clip names cannot contain control characters.")
      .refine(name => !/[\uD800-\uDFFF]/u.test(name), "Clip names must contain valid Unicode text.").optional(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  }).strict().refine(range => range.endMs > range.startMs);
  for (const method of ["post", "patch"] as const) {
    app[method](method === "post" ? "/api/jobs/:id/clips" : "/api/jobs/:id/clips/:clipId", async (req, res) => {
      const job = store.get(req.params.id!);
      if (!job) { res.status(404).json({ error: "Session not found." }); return; }
      const range = clipRange.parse(req.body);
      if (!recordingAvailable(job) || !job.durationMs || !Number.isFinite(job.durationMs)) {
        res.status(409).json({ error: "A retained recording with a known duration is required to create clips." }); return;
      }
      if (range.endMs > job.durationMs) {
        res.status(400).json({ error: "Clip end exceeds the recording duration." }); return;
      }
      const clipId = "clipId" in req.params ? req.params.clipId : undefined;
      if (method === "patch" && (!clipId || !accounts.clip(job.id, clipId))) {
        res.status(404).json({ error: "Clip not found." }); return;
      }
      await stat(store.audioPath(job.id));
      res.status(method === "post" ? 201 : 200).json(accounts.saveClip(job.id, range.startMs, range.endMs,
        method === "patch" ? clipId : undefined, range.name));
    });
  }
  let clipExports = 0;
  const exportingJobs = new Set<string>();
  app.get("/api/jobs/:id/clips/:clipId/export", async (req, res) => {
    const job = store.get(req.params.id!);
    const clip = accounts.clip(req.params.id!, req.params.clipId!);
    if (!job || !clip) { res.status(404).json({ error: "Clip not found." }); return; }
    if (!recordingAvailable(job)) { res.status(410).json({ error: "Original recording unavailable. The saved clip range is kept, but cannot be exported." }); return; }
    if (clipExports >= 2 || exportingJobs.has(job.id)) {
      res.status(429).json({ error: "A clip export is already running. Wait and try again." }); return;
    }
    clipExports++;
    exportingJobs.add(job.id);
    let directory: string | undefined;
    try {
      await stat(store.audioPath(job.id));
      directory = await mkdtemp(path.join(os.tmpdir(), "scribe-clip-"));
      const output = path.join(directory, "clip.mp3");
      await extractAudioClip(config.ffmpeg, store.audioPath(job.id), output, clip.startMs, clip.endMs);
      if (!accounts.isActiveUser(accounts.userId(req)) || !accounts.ownsJob(accounts.userId(req), job.id)) {
        res.status(403).json({ error: "Your account no longer has access." }); return;
      }
      res.attachment(clipFilename(clip.name, clip.id)).type("audio/mpeg");
      await new Promise<void>((resolve, reject) => res.sendFile(output, { cacheControl: false }, error => error ? reject(error) : resolve()));
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { clipExports--; exportingJobs.delete(job.id); }
    }
  });
  app.post("/api/demo", async (req, res) => {
    const demo = createDemo();
    accounts.assignJob(demo.id, accounts.userId(req));
    try {
      const saved = await store.save(demo);
      res.status(201).json(publicJob(saved));
    } catch (error) {
      accounts.releaseJob(demo.id);
      throw error;
    }
  });

  const uploads = new Uploads(store, runner, accounts);
  uploads.register(app);
  app.patch("/api/jobs/:id/speakers", async (req, res) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (runner.busyIds.has(job.id)) { res.status(409).json({ error: "Wait for processing to finish before editing speakers." }); return; }
    const names = z.record(z.string(), z.string().trim().min(1).max(100)).parse(req.body);
    const known = new Set([...job.segments.map(s => s.speaker), ...Object.keys(job.speakerNames)]);
    if (Object.keys(names).some(id => !known.has(id))) { res.status(400).json({ error: "Unknown speaker ID." }); return; }
    if (Object.entries(names).every(([id, name]) => displaySpeaker(job, id) === name)) {
      res.json(publicJob(job));
      return;
    }
    const updated = await store.save({
      ...job, speakerNames: { ...job.speakerNames, ...names },
      recapStale: Boolean(job.recap),
      status: job.demo ? "completed" : "transcript_ready",
      stage: job.demo ? "Fictional demo speaker names saved" : "Speaker names saved. Regenerate recap to use the new names.",
    });
    res.json(publicJob(updated));
  });
  app.patch("/api/jobs/:id/transcript", async (req, res) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (runner.busyIds.has(job.id) || activeStatuses.has(job.status)) {
      res.status(409).json({ error: "Wait for processing to finish before editing the transcript." });
      return;
    }
    if (!job.segments.length) { res.status(409).json({ error: "A transcript is required first." }); return; }
    const edits = z.object({
      segments: z.array(z.union([
      z.object({
        id: z.string().min(1).max(100),
        text: z.string().trim().min(1).max(10000),
        speaker: z.string().min(1).max(100).optional(),
      }).strict(),
      z.object({ id: z.string().min(1).max(100), delete: z.literal(true) }).strict(),
      ])).min(1).max(100),
    }).strict().parse(req.body).segments;
    const byId = new Map(job.segments.map(segment => [segment.id, segment]));
    const knownSpeakers = new Set([...job.segments.map(segment => segment.speaker), ...Object.keys(job.speakerNames)]);
    const ids = new Set(edits.map(edit => edit.id));
    if (ids.size !== edits.length || edits.some(edit => !byId.has(edit.id))) {
      res.status(400).json({ error: "Transcript edits must use unique existing segment IDs." });
      return;
    }
    if (edits.some(edit => "speaker" in edit && edit.speaker !== undefined && !knownSpeakers.has(edit.speaker))) {
      res.status(400).json({ error: "Unknown speaker ID." });
      return;
    }
    const changes = new Map(edits.map(edit => [edit.id, edit]));
    const segments = job.segments.flatMap(segment => {
      const edit = changes.get(segment.id);
      if (!edit) return [segment];
      if ("delete" in edit) return [];
      return [{ ...segment, text: edit.text, speaker: edit.speaker ?? segment.speaker }];
    });
    if (segments.length === job.segments.length && segments.every((segment, index) =>
      segment.text === job.segments[index]!.text && segment.speaker === job.segments[index]!.speaker)) {
      res.json(publicJob(job));
      return;
    }
    const speakerNames = Object.fromEntries([...knownSpeakers].map(speaker => [speaker, displaySpeaker(job, speaker)]));
    if (transcriptCharacters({ ...job, segments }) > Math.max(config.recapMaxTranscriptChars, transcriptCharacters(job))) {
      res.status(413).json({ error: "These edits would make the transcript too long to summarize." }); return;
    }
    const updated = await store.save({
      ...job, segments, speakerNames, recapStale: Boolean(job.recap), error: undefined, status: "transcript_ready",
      stage: !segments.length ? "All transcript entries deleted. Original recording and saved recap kept."
        : job.recap ? "Transcript edits saved. Saved recap is out of date; regenerate to include the changes."
        : "Transcript edits saved.",
    });
    res.json(publicJob(updated));
  });
  app.post("/api/jobs/:id/recap", async (req, res) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (job.demo) { res.status(400).json({ error: "Demo recaps are fictional. Upload real audio to use Azure." }); return; }
    if (!job.segments.length) { res.status(409).json({ error: "A transcript is required first." }); return; }
    if (runner.busyIds.has(job.id)) { res.status(409).json({ error: "Session is already processing." }); return; }
    if (readiness().recapMissing.length) { res.status(503).json({ error: `Configure ${readiness().recapMissing.join(", ")} first.` }); return; }
    if (transcriptCharacters(job) > config.recapMaxTranscriptChars) {
      res.status(413).json({ error: `This transcript is too long for a recap (limit ${config.recapMaxTranscriptChars.toLocaleString("en-US")} characters).` }); return;
    }
    // Reserve synchronously so a transcript edit cannot slip in between the checks and the queued save.
    if (!runner.reserve(job.id)) { res.status(409).json({ error: "Session is already processing." }); return; }
    try {
      accounts.consumeQuota(accounts.userId(req), "recap", 1, config.quotas.recaps,
        `Daily recap limit reached (${config.quotas.recaps} per 24 hours). Try again later.`);
      await store.save({ ...job, status: "queued", stage: "Recap queued", error: undefined, queuedOperation: "recap" });
    } catch (error) {
      runner.release(job.id);
      throw error;
    }
    runner.enqueueRecap(job.id);
    res.status(202).json({ id: job.id });
  });
  app.get("/api/jobs/:id/export/:format", (req, res) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    const format = req.params.format;
    if (!["json", "txt", "srt", "md", "recap"].includes(format!)) { res.status(400).json({ error: "Unknown export format." }); return; }
    if (!job.segments.length && job.status !== "transcript_ready") { res.status(409).json({ error: "Transcript is not ready." }); return; }
    if (format === "recap" && !job.recap) { res.status(409).json({ error: "Recap is not ready." }); return; }
    const extension = format === "recap" ? "md" : format;
    res.attachment(format === "md" ? `transcript-${job.id}.md` : `session-${job.id}.${extension}`);
    res.type(format === "json" ? "application/json" : format === "md" ? "text/markdown" : "text/plain");
    res.send(format === "json" ? JSON.stringify(publicJob(job), null, 2) :
      format === "srt" ? transcriptSrt(job) : format === "md" ? transcriptMarkdown(job) :
      format === "recap" ? recapMarkdown(job) : transcriptText(job));
  });
  app.delete("/api/jobs/:id", async (req, res) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (runner.busyIds.has(job.id) || activeStatuses.has(job.status) || exportingJobs.has(job.id) || waveforms.isGenerating(job.id)) { res.status(409).json({ error: "Wait for processing, waveform generation, and clip exports to finish before deleting." }); return; }
    if (job.blobName || job.speechJobUrl) {
      const warnings = await new AzureSpeech().cleanup(job);
      if (warnings.length) { res.status(502).json({ error: warnings.join(" ") }); return; }
    }
    await store.remove(job.id);
    accounts.releaseJob(job.id);
    res.status(204).end();
  });
  app.use(express.static(publicDirectory));
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    const known = error instanceof AccountError ? { status: error.status, message: error.message } : uploadErrorStatus(error);
    if (known) { res.status(known.status).json({ error: known.message }); return; }
    const status = error instanceof z.ZodError ? 400 :
      error instanceof Error && "code" in error && error.code === "ENOENT" ? 404 :
      error instanceof Error && "status" in error && typeof error.status === "number" &&
      [400, 404, 413, 416, 429].includes(error.status) ? error.status : 500;
    console.error("HTTP request failed:", status === 500 && error instanceof Error ? error.message : `HTTP ${status}`);
    const message = status === 400 ? "Invalid request fields." :
      status === 404 ? "The recording file is missing. Upload the recording again for playback." :
      status === 413 ? "Request exceeds the allowed size." :
      status === 429 ? "Waveform generation is busy. Try again shortly." :
      status === 416 ? "Requested audio byte range is not available." : "Server error. Check the server log.";
    if (status === 416 && error instanceof Error && "headers" in error &&
        typeof error.headers === "object" && error.headers !== null && "Content-Range" in error.headers &&
        typeof error.headers["Content-Range"] === "string" && /^bytes \*\/\d+$/.test(error.headers["Content-Range"])) {
      res.set("Content-Range", error.headers["Content-Range"]);
    }
    res.status(status).type("application/json").json({ error: message });
  });
  app.locals.buildWaveform = async (id: string) => {
    const job = store.get(id);
    if (job && recordingAvailable(job) && job.durationMs) await waveforms.build(job.id, store.audioPath(job.id), job.durationMs);
  };
  app.locals.isRecordingBusy = (id: string) =>
    runner.busyIds.has(id) || exportingJobs.has(id) || waveforms.isGenerating(id);
  app.locals.uploads = uploads;
  return app;
}
