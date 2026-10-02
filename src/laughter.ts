import { spawn } from "node:child_process";
import { z } from "zod";
import { config } from "./config.js";

const detectorEventSchema = z.object({
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
}).strict();

const detectorResultSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.literal("yamnet"),
  modelVersion: z.string().min(1),
  profileVersion: z.string().min(1),
  events: z.array(detectorEventSchema),
}).strict();

export type DetectorResult = z.infer<typeof detectorResultSchema>;

export interface LaughterDetection {
  readonly enabled: boolean;
  detect(audioPath: string, durationMs: number): Promise<DetectorResult>;
}

export class LaughterDetector implements LaughterDetection {
  readonly enabled = config.laughterEnabled;

  detect(audioPath: string, durationMs: number): Promise<DetectorResult> {
    if (!this.enabled) throw new Error("Laughter detection is disabled.");
    const args = [
      config.laughterScript,
      "--audio", audioPath,
      "--model", config.yamnetModel,
      "--duration-ms", String(Math.floor(durationMs)),
      "--ffmpeg", config.ffmpeg,
      "--high-threshold", String(config.laughterHighThreshold),
      "--low-threshold", String(config.laughterLowThreshold),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(config.python, args, { windowsHide: true, shell: false });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, config.laughterTimeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 10 * 1024 * 1024) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });
      child.on("error", error => {
        clearTimeout(timer);
        reject(new Error(`Cannot start laughter detector with ${config.python}. Check PYTHON_PATH and detector dependencies.`, { cause: error }));
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error("Laughter detection exceeded its configured time limit."));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Laughter detector exited with code ${code}.`));
          return;
        }
        try {
          const result = detectorResultSchema.parse(JSON.parse(stdout));
          if (result.events.some(event =>
            event.endMs > durationMs || event.startMs >= event.endMs ||
            event.peakMs < event.startMs || event.peakMs > event.endMs)) {
            throw new Error("Laughter detector returned timestamps outside the recording.");
          }
          resolve(result);
        } catch (error) {
          reject(new Error("Laughter detector returned invalid output.", { cause: error }));
        }
      });
    });
  }
}
