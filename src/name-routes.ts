import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config, readiness } from "./config.js";
import { publicJob, transcriptCharacters, type Job } from "./domain.js";
import { activeStatuses, type JobRunner } from "./runner.js";
import type { JobStore } from "./store.js";
import type { Accounts } from "./accounts.js";
import { applyNameList, applySuggestions, type NameEntry } from "./names.js";

// Remembers accepted fixes as known mishearings, so future transcripts are fixed automatically.
export function learnVariants(entries: NameEntry[], learned: Array<{ before: string; after: string; term: string }>): NameEntry[] {
  const result = entries.map(entry => ({ ...entry, variants: [...entry.variants] }));
  for (const { before, after, term } of learned) {
    const entry = result.find(value => value.term === term);
    if (!entry) continue;
    // "Lonelywood's" -> "Lostleton's" teaches "Lonelywood"; anything that isn't a clean swap for the name is skipped.
    const strip = (value: string) => value.replace(/[\u2019']s$/i, "").trim();
    const variant = /[\u2019']s$/i.test(before) && /[\u2019']s$/i.test(after) ? strip(before) : before.trim();
    if (strip(after).toLocaleLowerCase() !== term.toLocaleLowerCase() && after.trim().toLocaleLowerCase() !== term.toLocaleLowerCase()) continue;
    if (!variant || variant.length > 80 || variant.split(/\s+/).length > 4 || /[\u0000-\u001f\u007f]/.test(variant)) continue;
    const known = new Set([entry.term, ...entry.variants].map(value => value.toLocaleLowerCase()));
    if (known.has(variant.toLocaleLowerCase()) || entry.variants.length >= 12) continue;
    entry.variants.push(variant);
  }
  return result;
}

export function registerNameRoutes(app: Express, store: JobStore, runner: JobRunner, accounts: Accounts) {
  const editable = (req: Request, res: Response): Job | undefined => {
    const job = store.get(String(req.params.id));
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (runner.busyIds.has(job.id) || activeStatuses.has(job.status)) {
      res.status(409).json({ error: "Wait for processing to finish before changing this session." }); return;
    }
    if (!job.segments.length) { res.status(409).json({ error: "A transcript is required first." }); return; }
    return job;
  };
  const saveTranscript = async (job: Job, segments: Job["segments"], stage: string, extra: Partial<Job> = {}) => {
    if (transcriptCharacters({ ...job, segments }) > Math.max(config.recapMaxTranscriptChars, transcriptCharacters(job))) {
      throw Object.assign(new Error("These fixes would make the transcript too long to summarize."), { status: 413 });
    }
    return store.save({
      ...job, ...extra, segments, recapStale: Boolean(job.recap), error: undefined, status: "transcript_ready",
      stage: job.recap ? `${stage} Saved recap is out of date; regenerate to include the changes.` : stage,
    });
  };

  app.get("/api/names", (req, res) => { res.json(accounts.nameList(accounts.userId(req))); });
  app.put("/api/names", (req, res) => {
    const body = z.object({ entries: z.array(z.unknown()).max(300), autoApply: z.boolean() }).strict().parse(req.body);
    res.json(accounts.saveNameList(accounts.userId(req), body.entries as NameEntry[], body.autoApply));
  });

  app.post("/api/jobs/:id/names/preview", (req, res) => {
    const job = editable(req, res);
    if (!job) return;
    const { changes, count } = applyNameList(job.segments, accounts.nameList(accounts.userId(req)).entries);
    res.json({ count, lines: changes.length, examples: changes.slice(0, 50) });
  });
  app.post("/api/jobs/:id/names/apply", async (req, res) => {
    const job = editable(req, res);
    if (!job) return;
    const { segments, count, changes } = applyNameList(job.segments, accounts.nameList(accounts.userId(req)).entries);
    if (!count) { res.json(publicJob(job)); return; }
    const updated = await saveTranscript(job, segments,
      `Fixed ${count} listed name${count === 1 ? "" : "s"} on ${changes.length} line${changes.length === 1 ? "" : "s"}.`);
    res.json(publicJob(updated));
  });

  app.post("/api/jobs/:id/names/suggest", async (req, res) => {
    const job = editable(req, res);
    if (!job) return;
    if (job.demo) { res.status(400).json({ error: "The fictional demo cannot use Azure." }); return; }
    if (readiness().recapMissing.length) { res.status(503).json({ error: `Configure ${readiness().recapMissing.join(", ")} first.` }); return; }
    if (!accounts.nameList(accounts.userId(req)).entries.length) {
      res.status(409).json({ error: "Add the correct spellings to your names list first." }); return;
    }
    if (transcriptCharacters(job) > config.recapMaxTranscriptChars) {
      res.status(413).json({ error: "This transcript is too long to check." }); return;
    }
    if (!runner.reserve(job.id)) { res.status(409).json({ error: "Session is already processing." }); return; }
    try {
      // Costs about as much as reading the transcript for a recap, so it shares the recap allowance.
      accounts.consumeQuota(accounts.userId(req), "recap", 1, config.quotas.recaps,
        `Daily recap limit reached (${config.quotas.recaps} per 24 hours). Name checks share it. Try again later.`);
      await store.save({ ...job, status: "queued", stage: "Name check queued", error: undefined, queuedOperation: "names" });
    } catch (error) {
      runner.release(job.id);
      throw error;
    }
    runner.enqueueNames(job.id);
    res.status(202).json({ id: job.id });
  });
  app.post("/api/jobs/:id/names/accept", async (req, res) => {
    const job = editable(req, res);
    if (!job) return;
    const body = z.object({ ids: z.array(z.string().max(100)).max(2000), remember: z.boolean().default(false) }).strict().parse(req.body);
    const pending = job.nameSuggestions?.items ?? [];
    const chosen = new Set(body.ids);
    const { segments, applied } = applySuggestions(job.segments, pending.filter(item => chosen.has(item.id)));
    if (body.remember && applied.size) {
      const userId = accounts.userId(req);
      const list = accounts.nameList(userId);
      accounts.saveNameList(userId, learnVariants(list.entries, pending.filter(item => applied.has(item.id))), list.autoApply);
    }
    // Reviewing settles the whole list: anything not accepted was rejected.
    if (!applied.size) { res.json(publicJob(await store.save({ ...job, nameSuggestions: undefined }))); return; }
    const updated = await saveTranscript(job, segments,
      `Applied ${applied.size} name fix${applied.size === 1 ? "" : "es"}.`, { nameSuggestions: undefined });
    res.json(publicJob(updated));
  });
  app.delete("/api/jobs/:id/names/suggestions", async (req, res) => {
    const job = editable(req, res);
    if (!job) return;
    res.json(publicJob(await store.save({ ...job, nameSuggestions: undefined })));
  });

  app.put("/api/jobs/:id/clarifications", async (req, res) => {
    const job = store.get(req.params.id!);
    if (!job) { res.status(404).json({ error: "Session not found." }); return; }
    if (runner.busyIds.has(job.id) || activeStatuses.has(job.status)) {
      res.status(409).json({ error: "Wait for processing to finish before changing this session." }); return;
    }
    const items = z.object({
      clarifications: z.array(z.object({
        text: z.string().trim().min(1).max(500).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/),
        about: z.string().trim().max(3000).optional(),
      }).strict()).max(50),
    }).strict().parse(req.body).clarifications;
    const same = items.length === job.clarifications.length &&
      items.every((item, index) => item.text === job.clarifications[index]!.text && (item.about || undefined) === job.clarifications[index]!.about);
    if (same) { res.json(publicJob(job)); return; }
    const now = new Date().toISOString();
    const updated = await store.save({
      ...job,
      clarifications: items.map(item => ({ id: randomUUID(), text: item.text, ...(item.about ? { about: item.about } : {}), createdAt: now })),
      recapStale: Boolean(job.recap) || job.recapStale,
      stage: job.recap ? "Clarifications saved. Regenerate the recap to use them." : "Clarifications saved.",
    });
    res.json(publicJob(updated));
  });
}
