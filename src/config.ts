import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const env = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().default("./data"),
  APP_ADMIN_EMAIL: z.union([z.literal(""), z.email()]).default(""),
  APP_PUBLIC_ORIGIN: z.string().default(""),
  AZURE_SPEECH_ENDPOINT: z.string().default(""),
  AZURE_SPEECH_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2025-10-15"),
  AZURE_STORAGE_ACCOUNT_URL: z.string().default(""),
  AZURE_STORAGE_CONTAINER: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).default("dnd-audio"),
  // Optional: account key for temporary Speech-input storage that the app's identity cannot reach
  // (e.g. another tenant). Provide it as a platform secret, never in a committed file.
  AZURE_STORAGE_ACCOUNT_KEY: z.string().regex(/^$|^[A-Za-z0-9+/]{86}==$/).default(""),
  AZURE_STORAGE_GATEWAY_URL: z.string().default(""),
  AZURE_STORAGE_GATEWAY_SCOPE: z.string().regex(/^$|^api:\/\/[a-zA-Z0-9._-]+\/\.default$/).default(""),
  AZURE_OPENAI_ENDPOINT: z.string().default(""),
  AZURE_OPENAI_DEPLOYMENT: z.string().default(""),
  AZURE_OPENAI_REASONING_EFFORT: z.enum(["", "none", "minimal", "low", "medium", "high", "xhigh"]).default(""),
  AZURE_OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().min(2048).max(64000).default(16000),
  AZURE_AUTH_MODE: z.enum(["certificate", "managed-identity", "azure-cli"]).default("certificate"),
  AZURE_TENANT_ID: z.string().default(""),
  AZURE_CLIENT_ID: z.string().default(""),
  AZURE_CLIENT_CERTIFICATE_PATH: z.string().default(""),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  LAUGHTER_DETECTION_ENABLED: z.enum(["true", "false"]).default("true"),
  // Evens out loud and quiet voices in the copy sent to Azure Speech (the stored original is never changed).
  SPEECH_INPUT_LEVELING: z.enum(["true", "false"]).default("true"),
  PYTHON_PATH: z.string().default("python"),
  YAMNET_MODEL_PATH: z.string().default("./detector/models/yamnet"),
  LAUGHTER_DETECTOR_SCRIPT: z.string().default("./detector/detect_laughter.py"),
  LAUGHTER_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),
  LAUGHTER_LOW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.05),
  LAUGHTER_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(60),
  // Number of reverse proxies in front of Node that append to X-Forwarded-For (Azure Container Apps
  // ingress: 1). The client is then the entry that proxy appended; anything a client sends is to its left.
  TRUST_PROXY: z.string().regex(/^[0-3]?$/).default(""),
  // Diagnostics: log the shape of the forwarding chain (public/private per hop, no addresses) on sign-in.
  LOG_FORWARDING: z.enum(["true", "false"]).default("false"),
  // WAL needs shared memory and is unsafe on SMB/NFS shares; use DELETE when DATA_DIR is a network mount.
  SQLITE_JOURNAL_MODE: z.enum(["WAL", "DELETE", "TRUNCATE"]).default("WAL"),
  // Self-service access requests create pending accounts. Off: only invitation links can register.
  APP_OPEN_SIGNUP: z.enum(["true", "false"]).default("false"),
  RECORDING_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  DAILY_UPLOADS_PER_USER: z.coerce.number().int().min(1).max(1000).default(15),
  DAILY_AUDIO_HOURS_PER_USER: z.coerce.number().min(1).max(1000).default(100),
  DAILY_RECAPS_PER_USER: z.coerce.number().int().min(1).max(1000).default(100),
  DAILY_LAUGHTER_RUNS_PER_USER: z.coerce.number().int().min(1).max(1000).default(15),
  RECAP_MAX_TRANSCRIPT_CHARS: z.coerce.number().int().min(10_000).max(5_000_000).default(400_000),
  MIN_FREE_DISK_MB: z.coerce.number().int().min(0).default(2048),
}).parse(process.env);

function endpoint(value: string, suffixes: string[]): string {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== "/" || !suffixes.some(suffix => url.hostname.endsWith(suffix))) {
    throw new Error("Use an HTTPS Azure resource root endpoint, without a path or query.");
  }
  return url.origin;
}

export const config = {
  host: env.HOST,
  port: env.PORT,
  dataDir: path.resolve(env.DATA_DIR),
  adminEmail: env.APP_ADMIN_EMAIL.trim().toLowerCase(),
  publicOrigin: env.APP_PUBLIC_ORIGIN ? applicationOrigin(env.APP_PUBLIC_ORIGIN) : "",
  speechEndpoint: endpoint(env.AZURE_SPEECH_ENDPOINT, [".cognitiveservices.azure.com", ".api.cognitive.microsoft.com"]),
  speechApiVersion: env.AZURE_SPEECH_API_VERSION,
  storageAccountUrl: endpoint(env.AZURE_STORAGE_ACCOUNT_URL, [".blob.core.windows.net"]),
  storageContainer: env.AZURE_STORAGE_CONTAINER,
  storageAccountKey: env.AZURE_STORAGE_ACCOUNT_KEY,
  storageGatewayUrl: endpoint(env.AZURE_STORAGE_GATEWAY_URL, [".azurewebsites.net"]),
  storageGatewayScope: env.AZURE_STORAGE_GATEWAY_SCOPE,
  openaiEndpoint: endpoint(env.AZURE_OPENAI_ENDPOINT, [".openai.azure.com", ".cognitiveservices.azure.com"]),
  openaiDeployment: env.AZURE_OPENAI_DEPLOYMENT,
  openaiReasoningEffort: env.AZURE_OPENAI_REASONING_EFFORT,
  openaiMaxCompletionTokens: env.AZURE_OPENAI_MAX_COMPLETION_TOKENS,
  authMode: env.AZURE_AUTH_MODE,
  tenantId: env.AZURE_TENANT_ID,
  clientId: env.AZURE_CLIENT_ID,
  certificatePath: env.AZURE_CLIENT_CERTIFICATE_PATH ? path.resolve(env.AZURE_CLIENT_CERTIFICATE_PATH) : "",
  ffmpeg: env.FFMPEG_PATH,
  ffprobe: env.FFPROBE_PATH,
  laughterEnabled: env.LAUGHTER_DETECTION_ENABLED === "true",
  speechInputLeveling: env.SPEECH_INPUT_LEVELING === "true",
  python: env.PYTHON_PATH,
  yamnetModel: path.resolve(env.YAMNET_MODEL_PATH),
  laughterScript: path.resolve(env.LAUGHTER_DETECTOR_SCRIPT),
  laughterHighThreshold: env.LAUGHTER_HIGH_THRESHOLD,
  laughterLowThreshold: env.LAUGHTER_LOW_THRESHOLD,
  laughterTimeoutMs: env.LAUGHTER_TIMEOUT_MINUTES * 60_000,
  trustProxy: Number(env.TRUST_PROXY || 0),
  logForwarding: env.LOG_FORWARDING === "true",
  sqliteJournalMode: env.SQLITE_JOURNAL_MODE,
  openSignup: env.APP_OPEN_SIGNUP === "true",
  retentionDays: env.RECORDING_RETENTION_DAYS,
  quotas: {
    uploads: env.DAILY_UPLOADS_PER_USER,
    audioMs: env.DAILY_AUDIO_HOURS_PER_USER * 3_600_000,
    recaps: env.DAILY_RECAPS_PER_USER,
    laughter: env.DAILY_LAUGHTER_RUNS_PER_USER,
  },
  recapMaxTranscriptChars: env.RECAP_MAX_TRANSCRIPT_CHARS,
  minFreeDiskBytes: env.MIN_FREE_DISK_MB * 1024 * 1024,
};

const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;
if (!loopbackHost.test(config.host) && !config.publicOrigin) {
  throw new Error("Binding to a non-loopback HOST requires APP_PUBLIC_ORIGIN (the exact public HTTPS origin).");
}
if (config.trustProxy && !config.publicOrigin) {
  throw new Error("TRUST_PROXY is only valid with APP_PUBLIC_ORIGIN behind a known reverse proxy.");
}

function applicationOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== "/") {
    throw new Error("APP_PUBLIC_ORIGIN must be an HTTPS application root without credentials, a path, or a query.");
  }
  return url.origin;
}

if (config.storageGatewayUrl && (!config.storageGatewayScope || config.authMode !== "certificate")) {
  throw new Error("Storage gateway requires AZURE_STORAGE_GATEWAY_SCOPE and explicit certificate authentication.");
}
if (config.storageAccountKey && config.storageGatewayUrl) {
  throw new Error("Use either AZURE_STORAGE_ACCOUNT_KEY or the storage gateway, not both.");
}
if (config.storageGatewayScope && !config.storageGatewayUrl) {
  throw new Error("AZURE_STORAGE_GATEWAY_SCOPE requires AZURE_STORAGE_GATEWAY_URL.");
}

export function readiness() {
  const authenticationMissing = config.authMode === "certificate" ? [
    !config.tenantId && "AZURE_TENANT_ID",
    !config.clientId && "AZURE_CLIENT_ID",
    !config.certificatePath && "AZURE_CLIENT_CERTIFICATE_PATH",
  ].filter(Boolean) : [];
  const transcriptionMissing = [
    !config.speechEndpoint && "AZURE_SPEECH_ENDPOINT",
    !config.storageAccountUrl && "AZURE_STORAGE_ACCOUNT_URL",
    ...authenticationMissing,
  ].filter(Boolean);
  const recapMissing = [
    !config.openaiEndpoint && "AZURE_OPENAI_ENDPOINT",
    !config.openaiDeployment && "AZURE_OPENAI_DEPLOYMENT",
    ...authenticationMissing,
  ].filter(Boolean);
  return {
    transcriptionMissing, recapMissing, authMode: config.authMode, maxUploadMB: 500, maxDurationHours: 4,
    laughterDetectionEnabled: config.laughterEnabled, retentionDays: config.retentionDays,
  };
}
