import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";

export function clipFilename(name: string, id: string): string {
  let stem = name.replace(/\.mp3$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/^[. ]+|[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(stem)) stem = `clip-${stem}`;
  let bounded = "";
  for (const character of stem) {
    if (Buffer.byteLength(bounded + character, "utf8") > 180) break;
    bounded += character;
  }
  return `${bounded.replace(/[. ]+$/g, "") || `clip-${id}`}.mp3`;
}

export function recordingFormat(filename: string): "mp3" | "opus" | undefined {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".mp3") return "mp3";
  if (extension === ".opus" || extension === ".ogg") return "opus";
  return undefined;
}

export function runTool(executable: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false });
    let output = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 1024 * 1024) output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(new Error(`Cannot run ${executable}. Install FFmpeg/ffprobe and check executable configuration.`, { cause: error }));
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Audio processing exceeded its time limit."));
      else if (code !== 0) {
        console.error(`Audio tool exited with code ${code}: ${stderr.trim()}`);
        reject(new Error("Audio processing failed. The recording may be damaged or use an unsupported encoding."));
      }
      else resolve(output);
    });
  });
}

export async function inspectRecording(executable: string, file: string, originalName: string): Promise<number> {
  const output = await runTool(executable, [
    "-v", "error", "-show_entries", "format=duration,format_name:stream=codec_name,codec_type",
    "-of", "json", file,
  ], 60_000);
  const metadata = z.object({
    format: z.object({ duration: z.coerce.number().positive(), format_name: z.string() }),
    streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string() })),
  }).parse(JSON.parse(output));
  return validateRecordingMetadata(metadata, originalName);
}

export function validateRecordingMetadata(metadata: {
  format: { duration: number; format_name: string };
  streams: { codec_type: string; codec_name: string }[];
}, originalName: string): number {
  const codec = recordingFormat(originalName);
  if (!codec) throw new Error("Only MP3 and Ogg Opus (.opus or .ogg) recordings are supported.");
  if (metadata.format.format_name !== (codec === "opus" ? "ogg" : "mp3") ||
      !metadata.streams.some(s => s.codec_type === "audio" && s.codec_name === codec)) {
    throw new Error(codec === "opus"
      ? "This file is not a valid Ogg Opus recording. Ogg Vorbis is not supported."
      : "This file is not a valid MP3 recording.");
  }
  const durationMs = metadata.format.duration * 1000;
  if (durationMs > 4 * 60 * 60 * 1000) {
    throw new Error("This recording exceeds Azure batch diarization's 4-hour limit. Split it manually; speaker labels will not carry across files.");
  }
  return durationMs;
}

export async function normalizeAudio(executable: string, input: string, output: string, maxDurationMs?: number) {
  await runTool(executable, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input,
    ...(maxDurationMs ? ["-t", String(maxDurationMs / 1000)] : []),
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "64k", output,
  ], 30 * 60 * 1000);
}

// Duration of audio this app encoded itself (fully decoded CBR output), unlike uploader-controlled headers.
export async function inspectDecodedDuration(executable: string, file: string): Promise<number> {
  const output = await runTool(executable, ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], 60_000);
  return z.object({ format: z.object({ duration: z.coerce.number().nonnegative() }) }).parse(JSON.parse(output)).format.duration * 1000;
}

export async function extractAudioClip(executable: string, input: string, output: string, startMs: number, endMs: number) {
  await runTool(executable, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(startMs / 1000), "-i", input, "-t", String((endMs - startMs) / 1000),
    "-map", "0:a:0", "-vn", "-codec:a", "libmp3lame", "-b:a", "192k", output,
  ], 10 * 60 * 1000);
}
