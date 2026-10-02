export const maxGatewayBytes = 128 * 1024 * 1024;
export const audioBlobPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/mono\.mp3$/;

export function requireAudioBlobName(blobName: string): void {
  if (!audioBlobPattern.test(blobName)) throw new Error("Invalid job audio blob name.");
}

export function expectedAudioUrl(accountUrl: string, container: string, blobName: string): string {
  requireAudioBlobName(blobName);
  return `${accountUrl}/${container}/${blobName}`;
}
