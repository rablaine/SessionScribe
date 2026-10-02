import { z } from "zod";

export const segmentSchema = z.object({
  id: z.string(),
  speaker: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export type Segment = z.infer<typeof segmentSchema>;

export const laughterEventSchema = z.object({
  id: z.string().regex(/^L\d{5}$/),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  peakMs: z.number().int().nonnegative(),
  peakConfidence: z.number().min(0).max(1),
  meanConfidence: z.number().min(0).max(1),
  labels: z.array(z.object({
    name: z.string().min(1),
    peakConfidence: z.number().min(0).max(1),
  }).strict()).min(1),
}).strict().refine(event =>
  event.endMs > event.startMs && event.peakMs >= event.startMs && event.peakMs <= event.endMs,
{ message: "Laughter event timestamps are out of order." });
export type LaughterEvent = z.infer<typeof laughterEventSchema>;

export const laughterAnalysisSchema = z.object({
  status: z.enum(["pending", "queued", "running", "completed", "failed", "skipped"]).default("pending"),
  events: z.array(laughterEventSchema).default([]),
  model: z.literal("yamnet").optional(),
  modelVersion: z.string().optional(),
  profileVersion: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});

const factSchema = z.object({
  text: z.string().min(1).max(3000),
  segmentIds: z.array(z.string()).max(40).default([]),
});
const recapSceneSchema = z.object({
  title: z.string().min(1).max(200),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
}).refine(scene => scene.endMs >= scene.startMs, { message: "Scene end must not precede its start." });
const narrativeRecapSchema = z.object({
  title: z.string().min(1).max(200),
  // Older category recaps can migrate into up to 162 narrative items.
  paragraphs: z.array(factSchema).min(1).max(162),
  uncertainties: z.array(factSchema).max(30),
  scenes: z.array(recapSceneSchema).max(500).default([]),
});
const legacyRecapSchema = z.object({
  title: z.string().min(1).max(200),
  overview: z.array(factSchema).max(12),
  keyEvents: z.array(factSchema).max(30),
  charactersAndPlaces: z.array(factSchema).max(30),
  decisionsAndDiscoveries: z.array(factSchema).max(30),
  lootAndRewards: z.array(factSchema).max(30),
  unresolvedThreads: z.array(factSchema).max(30),
  uncertainties: z.array(factSchema).max(30),
});
export const recapSchema = z.union([narrativeRecapSchema, legacyRecapSchema]).transform(recap => {
  if ("paragraphs" in recap) return recap;
  const paragraphs = [
    ...recap.overview,
    ...recap.keyEvents,
    ...recap.charactersAndPlaces,
    ...recap.decisionsAndDiscoveries,
    ...recap.lootAndRewards,
    ...recap.unresolvedThreads,
  ];
  if (!paragraphs.length) throw new Error("Recap returned no narrative.");
  return { title: recap.title, paragraphs, uncertainties: recap.uncertainties, scenes: [] };
});
export type Recap = z.infer<typeof recapSchema>;
export const recapKeys = ["paragraphs", "uncertainties"] as const;

export const jobSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  originalName: z.string(),
  audioRetained: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["queued", "normalizing", "uploading", "transcribing", "summarizing", "transcript_ready", "completed", "failed"]),
  stage: z.string(),
  demo: z.boolean().default(false),
  locale: z.string(),
  maxSpeakers: z.number().int().min(2).max(35),
  context: z.string(),
  durationMs: z.number().optional(),
  segments: z.array(segmentSchema).default([]),
  laughter: laughterAnalysisSchema.default({ status: "pending", events: [] }),
  speakerNames: z.record(z.string(), z.string()).default({}),
  recap: recapSchema.optional(),
  recapStale: z.boolean().default(false),
  error: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  speechJobUrl: z.string().optional(),
  blobName: z.string().optional(),
  // Original-recording lifecycle. Expiry is fixed at acceptance; playback/editing never extend it.
  recordingUploadedAt: z.string().optional(),
  recordingExpiresAt: z.string().optional(),
  recordingPurgedAt: z.string().optional(),
});
export type Job = z.infer<typeof jobSchema>;

export type RecordingState = "available" | "expired" | "unavailable" | "none";

export function recordingState(job: Job, now = Date.now()): RecordingState {
  if (job.audioRetained) {
    return job.recordingExpiresAt && Date.parse(job.recordingExpiresAt) <= now ? "expired" : "available";
  }
  if (job.demo) return "none";
  return job.recordingPurgedAt ? "expired" : "unavailable";
}

// True only while the original may still be served or processed, even if physical purge is pending.
export function recordingAvailable(job: Job, now = Date.now()): boolean {
  return recordingState(job, now) === "available";
}

export function recordingExpiry(acceptedAt: string, retentionDays: number): string | undefined {
  return retentionDays > 0 ? new Date(Date.parse(acceptedAt) + retentionDays * 86_400_000).toISOString() : undefined;
}

export function timestamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2, "0")).join(":");
}

const batchSchema = z.object({
  recognizedPhrases: z.array(z.object({
    recognitionStatus: z.string(),
    speaker: z.number().int().nonnegative().optional(),
    offsetInTicks: z.number().nonnegative(),
    durationInTicks: z.number().nonnegative(),
    nBest: z.array(z.object({
      display: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    })),
  })),
});

export function parseBatchTranscript(raw: unknown): { segments: Segment[]; warnings: string[] } {
  const data = batchSchema.parse(raw);
  const warnings: string[] = [];
  const failed = data.recognizedPhrases.filter(p => p.recognitionStatus !== "Success").length;
  if (failed) warnings.push(`${failed} audio phrase(s) were not recognized successfully.`);
  const phrases = data.recognizedPhrases.filter(p => p.recognitionStatus === "Success");
  if (phrases.some(p => !p.nBest[0]?.display.trim())) {
    throw new Error("Speech returned a successful phrase without transcript text.");
  }
  const segments: Segment[] = phrases
    .sort((a, b) => a.offsetInTicks - b.offsetInTicks)
    .map((p, i) => {
      const best = p.nBest[0]!;
      return {
        id: `S${String(i + 1).padStart(5, "0")}`,
        speaker: p.speaker === undefined ? "unknown" : `speaker-${p.speaker}`,
        startMs: p.offsetInTicks / 10000,
        endMs: (p.offsetInTicks + p.durationInTicks) / 10000,
        text: best.display,
        confidence: best.confidence,
      };
    });
  if (!segments.length) throw new Error("No speech was recognized. Check recording quality and language.");
  if (segments.some(s => s.speaker === "unknown")) warnings.push("Some phrases have no speaker label; they are marked Unknown.");
  return { segments, warnings };
}

export function displaySpeaker(job: Job, id: string): string {
  return job.speakerNames[id] || (id === "unknown" ? "Unknown" : `Speaker ${id.replace("speaker-", "")}`);
}

export function transcriptCharacters(job: Pick<Job, "segments">): number {
  return job.segments.reduce((total, segment) => total + segment.text.length + segment.speaker.length + 32, 0);
}

export function publicJob(job: Job) {
  const { speechJobUrl, blobName, ...result } = job;
  const state = recordingState(job);
  // Once expired, report the recording as gone even if the background purge has not run yet.
  return { ...result, audioRetained: state === "available", recordingState: state };
}

export function transcriptText(job: Job): string {
  return job.segments.map(s =>
    `[${timestamp(s.startMs)} - ${timestamp(s.endMs)}] ${displaySpeaker(job, s.speaker)}: ${s.text}`,
  ).join("\n");
}

function markdownLiteral(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}#|~]/g, "\\$&");
}

export function transcriptMarkdown(job: Job): string {
  const title = markdownLiteral(job.title.replace(/[\r\n]+/g, " "));
  const intro = job.demo ? "\n\n> DEMO: fictional sample, not a processed recording." : "";
  const paragraphs = job.segments.map(segment => {
    const speaker = markdownLiteral(displaySpeaker(job, segment.speaker).replace(/[\r\n]+/g, " "));
    const text = markdownLiteral(segment.text).replace(/\r?\n/g, "  \n");
    return `**[${timestamp(segment.startMs)} - ${timestamp(segment.endMs)}] ${speaker}**  \n${text}`;
  });
  return `# ${title}${intro}\n\n${paragraphs.join("\n\n")}\n`;
}

function srtTime(ms: number): string {
  return `${timestamp(ms)},${String(Math.floor(ms % 1000)).padStart(3, "0")}`;
}

export function transcriptSrt(job: Job): string {
  return job.segments.map((s, i) =>
    `${i + 1}\n${srtTime(s.startMs)} --> ${srtTime(s.endMs)}\n${displaySpeaker(job, s.speaker)}: ${s.text}\n`,
  ).join("\n");
}

export function recapMarkdown(job: Job): string {
  if (!job.recap) throw new Error("No recap available.");
  const byId = new Map(job.segments.map(s => [s.id, s]));
  const renderReferences = (segmentIds: string[]) => segmentIds.map(id => {
    const segment = byId.get(id);
    return segment ? `${id} @ ${timestamp(segment.startMs)}` : `${id} (deleted entry)`;
  }).join(", ");
  const narrative = job.recap.paragraphs.map(paragraph =>
    `${markdownLiteral(paragraph.text)}${paragraph.segmentIds.length
      ? `\n\n_Transcript references: ${renderReferences(paragraph.segmentIds)}_` : ""}`,
  );
  const uncertainties = job.recap.uncertainties.length
    ? [`## Uncertainties\n${job.recap.uncertainties.map(item =>
      `- ${markdownLiteral(item.text)}${item.segmentIds.length ? ` (${renderReferences(item.segmentIds)})` : ""}`,
    ).join("\n")}`]
    : [];
  const scenes = job.recap.scenes.length ? [
    `## Recording navigation\n\nSource-chunk time ranges, not verified citations for the prose.\n\n${
      job.recap.scenes.map(scene =>
        `- ${timestamp(scene.startMs)} - ${timestamp(scene.endMs)}: ${markdownLiteral(scene.title)}`,
      ).join("\n")
    }`,
  ] : [];
  return [`# ${markdownLiteral(job.recap.title)}`, job.demo ? "> DEMO: fictional sample, not a processed recording." : "> AI draft: verify against the transcript.",
    ...(job.recapStale ? ["> OUT OF DATE: The transcript has changed since this recap was generated. Regenerate the recap to include the saved changes."] : []),
    ...narrative,
    ...uncertainties,
    ...scenes,
  ].join("\n\n");
}

export function validateEvidence(recap: Recap, allowedIds: Set<string>): Recap {
  for (const key of recapKeys) {
    for (const fact of recap[key]) {
      const invalid = fact.segmentIds.filter(id => !allowedIds.has(id));
      if (invalid.length) {
        throw new Error(
          `Recap returned source reference(s) not present in this source: ${[...new Set(invalid)].join(", ")}. ` +
          "Replace them with IDs from the supplied source metadata.",
        );
      }
    }
  }
  if (!recap.paragraphs.length) throw new Error("Recap returned no narrative.");
  return recap;
}
