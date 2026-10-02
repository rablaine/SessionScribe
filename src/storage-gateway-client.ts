import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { config } from "./config.js";
import { storageGatewayHeaders } from "./auth.js";
import { expectedAudioUrl, maxGatewayBytes, requireAudioBlobName } from "./storage-contract.js";

export class StorageGatewayClient {
  constructor(private headers = storageGatewayHeaders) {}

  private url(blobName: string) {
    requireAudioBlobName(blobName);
    return `${config.storageGatewayUrl}/audio/${blobName}`;
  }

  async upload(file: string, blobName: string): Promise<string> {
    const url = this.url(blobName);
    const size = (await stat(file)).size;
    if (size < 1 || size > maxGatewayBytes) throw new Error("Normalized audio exceeds the storage gateway's 128 MiB limit or is empty.");
    const headers = await this.headers();
    const stream = createReadStream(file);
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT", redirect: "error", duplex: "half",
        headers: { ...headers, "Content-Type": "audio/mpeg", "Content-Length": String(size) },
        body: Readable.toWeb(stream) as ReadableStream,
        signal: AbortSignal.timeout(30 * 60_000),
      };
      const response = await fetch(url, init);
      if (response.status !== 201) throw new Error(`Storage gateway upload failed: HTTP ${response.status}.`);
      const result: unknown = await response.json();
      const expected = expectedAudioUrl(config.storageAccountUrl, config.storageContainer, blobName);
      if (typeof result !== "object" || result === null || !("audioUrl" in result) ||
          result.audioUrl !== expected || response.headers.get("Location") !== expected) {
        throw new Error("Storage gateway returned an unexpected audio URL.");
      }
      return expected;
    } finally {
      stream.destroy();
    }
  }

  async delete(blobName: string): Promise<void> {
    const response = await fetch(this.url(blobName), {
      method: "DELETE", headers: await this.headers(), redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status !== 204) throw new Error(`Storage gateway deletion failed: HTTP ${response.status}.`);
  }
}
