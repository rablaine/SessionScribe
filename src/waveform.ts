import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const bucketMs = 10;
const maximumDurationMs = 4 * 60 * 60 * 1000;

export function decodePeaks(executable: string, input: string, durationMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const output = Buffer.alloc((Math.ceil(durationMs / bucketMs) + 100) * 2);
    const child = spawn(executable, ["-nostdin", "-v", "error", "-i", input, "-map", "0:a:0",
      "-vn", "-ac", "2", "-ar", "8000", "-f", "s16le", "pipe:1"], { windowsHide: true, shell: false });
    let carry = Buffer.alloc(0);
    let peak = 0;
    let frames = 0;
    let count = 0;
    let stderr = "";
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("Waveform generation exceeded its time limit.");
      child.kill();
    }, 30 * 60 * 1000);
    function append() {
      if ((count + 1) * 2 > output.length) {
        failure = new Error("Recording duration differs from its saved metadata. Waveform generation stopped.");
        child.kill();
        return;
      }
      output.writeUInt16LE(peak, count++ * 2);
      peak = 0;
      frames = 0;
    }
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const length = bytes.length - bytes.length % 4;
      for (let offset = 0; offset < length && !failure; offset += 4) {
        peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)), Math.abs(bytes.readInt16LE(offset + 2)));
        if (++frames === 80) append();
      }
      carry = Buffer.from(bytes.subarray(length));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", error => {
      clearTimeout(timer);
      reject(new Error("Cannot run FFmpeg for the waveform. Check executable configuration.", { cause: error }));
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (frames && !failure) append();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Waveform generation failed (${code}): ${stderr}`));
      else if (!count || carry.length) reject(new Error("FFmpeg returned incomplete waveform audio."));
      else resolve(output.subarray(0, count * 2));
    });
  });
}

export function waveformWindow(peaks: Buffer, startMs: number, endMs: number, bins: number) {
  if (!peaks.length || peaks.length % 2 || peaks.length > (maximumDurationMs / bucketMs + 100) * 2) {
    throw new Error("The waveform cache is invalid.");
  }
  let maximum = 0;
  for (let offset = 0; offset < peaks.length; offset += 2) maximum = Math.max(maximum, peaks.readUInt16LE(offset));
  const values = Array.from({ length: bins }, (_, bin) => {
    const from = Math.floor((startMs + (endMs - startMs) * bin / bins) / bucketMs);
    const to = Math.ceil((startMs + (endMs - startMs) * (bin + 1) / bins) / bucketMs);
    let peak = 0;
    for (let index = from; index < to && index * 2 < peaks.length; index++) {
      peak = Math.max(peak, peaks.readUInt16LE(index * 2));
    }
    return peak / 32768;
  });
  return { startMs, endMs, resolutionMs: bucketMs, maxAmplitude: maximum / 32768, peaks: values };
}

export class Waveforms {
  private pending = new Map<string, Promise<Buffer>>();
  constructor(private executable: string) {}
  isGenerating(id: string) { return this.pending.has(id); }
  async get(id: string, input: string, durationMs: number, startMs: number, endMs: number, bins: number) {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > maximumDurationMs) {
      throw new Error("A valid recording duration is required for a waveform.");
    }
    let pending = this.pending.get(id);
    if (!pending) {
      if (this.pending.size >= 2) throw Object.assign(new Error("Waveform generation is busy. Try again shortly."), { status: 429 });
      pending = this.load(input, durationMs);
      this.pending.set(id, pending);
    }
    try { return waveformWindow(await pending, startMs, endMs, bins); }
    finally { if (this.pending.get(id) === pending) this.pending.delete(id); }
  }
  private async load(input: string, durationMs: number) {
    const source = await stat(input);
    const cache = path.join(path.dirname(input), "waveform-v1.bin");
    try {
      const cached = await stat(cache);
      if (cached.mtimeMs >= source.mtimeMs) return await readFile(cache);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const peaks = await decodePeaks(this.executable, input, durationMs);
    const temporary = `${cache}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, peaks); await rename(temporary, cache); }
    finally { await rm(temporary, { force: true }); }
    return peaks;
  }
}
