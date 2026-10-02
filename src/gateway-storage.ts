import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import type { GatewayOptions, GatewayStorage } from "./gateway.js";

export function createManagedIdentityStorage(options: GatewayOptions): GatewayStorage {
  const container = new BlobServiceClient(options.storageAccountUrl, new ManagedIdentityCredential(), {
    retryOptions: { maxTries: 1 },
  }).getContainerClient(options.storageContainer);
  return {
    async upload(blobName, body, signal) {
      await container.getBlockBlobClient(blobName).uploadStream(body, 4 * 1024 * 1024, 2, {
        abortSignal: signal,
        blobHTTPHeaders: { blobContentType: "audio/mpeg" },
      });
    },
    async delete(blobName) {
      await container.getBlockBlobClient(blobName).deleteIfExists();
    },
    async probe() {
      await container.getProperties();
    },
  };
}
