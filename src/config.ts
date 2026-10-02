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
  PYTHON_PATH: z.string().default("python"),
  YAMNET_MODEL_PATH: z.string().default("./detector/models/yamnet"),
  LAUGHTER_DETECTOR_SCRIPT: z.string().default("./detector/detect_laughter.py"),
  LAUGHTER_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),
  LAUGHTER_LOW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.05),
  LAUGHTER_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(60),
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
  python: env.PYTHON_PATH,
  yamnetModel: path.resolve(env.YAMNET_MODEL_PATH),
  laughterScript: path.resolve(env.LAUGHTER_DETECTOR_SCRIPT),
  laughterHighThreshold: env.LAUGHTER_HIGH_THRESHOLD,
  laughterLowThreshold: env.LAUGHTER_LOW_THRESHOLD,
  laughterTimeoutMs: env.LAUGHTER_TIMEOUT_MINUTES * 60_000,
};

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
    laughterDetectionEnabled: config.laughterEnabled,
  };
}
