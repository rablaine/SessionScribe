import {
  BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, SASProtocol, StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { config } from "./config.js";
import { requestJson } from "./http.js";
import { parseBatchTranscript, type Job } from "./domain.js";
import { azureCredential, cognitiveHeaders } from "./auth.js";
import { StorageGatewayClient } from "./storage-gateway-client.js";

const submissionSchema = z.object({ self: z.url() });
const statusSchema = z.object({
  status: z.enum(["NotStarted", "Running", "Succeeded", "Failed"]),
  links: z.object({ files: z.url() }).optional(),
});
const filesSchema = z.object({
  values: z.array(z.object({ kind: z.string(), links: z.object({ contentUrl: z.url() }) })),
});

export function batchDefinition(job: Job, audioUrl: string) {
  return {
    displayName: `DND ${job.id}`,
    locale: job.locale,
    contentUrls: [audioUrl],
    properties: {
      diarization: { enabled: true, maxSpeakers: job.maxSpeakers },
      channels: [0],
      wordLevelTimestampsEnabled: true,
      displayFormWordLevelTimestampsEnabled: true,
      punctuationMode: "Automatic",
      profanityFilterMode: "None",
      timeToLiveHours: 48,
    },
  };
}

// Read-only, HTTPS-only link that Speech uses to fetch one temporary blob. It expires well before the
// temporary-audio lifecycle rule deletes the blob, and is never persisted or returned to browsers.
export function speechReadUrl(blobUrl: string, containerName: string, blobName: string,
  credential: StorageSharedKeyCredential, now = new Date()): string {
  const sas = generateBlobSASQueryParameters({
    containerName, blobName, permissions: BlobSASPermissions.parse("r"), protocol: SASProtocol.Https,
    startsOn: new Date(now.getTime() - 5 * 60_000), expiresOn: new Date(now.getTime() + 48 * 3_600_000),
  }, credential).toString();
  return `${blobUrl}?${sas}`;
}

export class AzureSpeech {
  constructor(private headers = cognitiveHeaders) {}

  private keyCredential() {
    return config.storageAccountKey
      ? new StorageSharedKeyCredential(new URL(config.storageAccountUrl).hostname.split(".")[0]!, config.storageAccountKey)
      : undefined;
  }
  private container() {
    return new BlobServiceClient(config.storageAccountUrl, this.keyCredential() ?? azureCredential())
      .getContainerClient(config.storageContainer);
  }
  private speechUrl(url: string) {
    const parsed = new URL(url);
    if (parsed.origin !== config.speechEndpoint || !parsed.pathname.startsWith("/speechtotext/")) {
      throw new Error("Speech returned an unexpected resource URL.");
    }
    return url;
  }

  async upload(file: string, blobName: string) {
    if (config.storageGatewayUrl) return new StorageGatewayClient().upload(file, blobName);
    const container = this.container();
    const blob = container.getBlockBlobClient(blobName);
    await blob.uploadFile(file, { blobHTTPHeaders: { blobContentType: "audio/mpeg" } });
    const key = this.keyCredential();
    // Key mode (storage in another tenant): Speech gets a short-lived read-only SAS.
    // Otherwise Speech reads the plain URL with its own system-assigned managed identity.
    return key ? speechReadUrl(blob.url, config.storageContainer, blobName, key) : blob.url;
  }

  async submit(job: Job, audioUrl: string) {
    const url = `${config.speechEndpoint}/speechtotext/transcriptions:submit?api-version=${config.speechApiVersion}`;
    const result = submissionSchema.parse(await requestJson(url, {
      method: "POST",
      headers: { ...await this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(batchDefinition(job, audioUrl)),
    }, false));
    return this.speechUrl(result.self);
  }

  async waitForTranscript(jobUrl: string, onStatus: (status: string) => Promise<void>) {
    const deadline = Date.now() + 24 * 60 * 60_000;
    while (Date.now() < deadline) {
      const result = statusSchema.parse(await requestJson(this.speechUrl(jobUrl), { headers: await this.headers() }));
      if (result.status === "Failed") {
        throw new Error("Azure Speech batch transcription failed. Check audio, locale, resource quota, and Speech managed-identity Blob permissions/network rules.");
      }
      if (result.status === "Succeeded") {
        if (!result.links) throw new Error("Speech job has no result file link.");
        const files = filesSchema.parse(await requestJson(this.speechUrl(result.links.files), { headers: await this.headers() }));
        const transcripts = files.values.filter(f => f.kind === "Transcription");
        if (transcripts.length !== 1) throw new Error("Expected exactly one transcription result for this recording.");
        const contentUrl = transcripts[0]!.links.contentUrl;
        const parsed = new URL(contentUrl);
        if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".blob.core.windows.net")) {
          throw new Error("Speech returned an unexpected transcript storage URL.");
        }
        // Service-owned results use their own SAS. Never forward the AI bearer token.
        return parseBatchTranscript(await requestJson(contentUrl));
      }
      await onStatus(result.status);
      await delay(15_000);
    }
    throw new Error("Speech job did not finish within 24 hours. Inspect it in Azure before retrying to avoid duplicate charges.");
  }

  async cleanup(job: Job) {
    const warnings: string[] = [];
    if (job.speechJobUrl) {
      try {
        await requestJson(this.speechUrl(job.speechJobUrl), { method: "DELETE", headers: await this.headers() }, false, true);
      } catch {
        warnings.push("Could not delete the Azure Speech job. Its results expire 48 hours after completion; inspect it in Azure.");
      }
    }
    if (job.blobName) {
      try {
        if (config.storageGatewayUrl) await new StorageGatewayClient().delete(job.blobName);
        else await this.container().getBlockBlobClient(job.blobName).deleteIfExists();
      } catch (error) {
        console.error("Private audio blob cleanup failed:", error);
        warnings.push("Could not delete the private Azure audio blob. Remove it in Storage or rely on your configured lifecycle policy.");
      }
    }
    return warnings;
  }
}
