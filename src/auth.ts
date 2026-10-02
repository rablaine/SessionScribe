import {
  AzureCliCredential, ClientCertificateCredential, ManagedIdentityCredential,
} from "@azure/identity";
import { config } from "./config.js";

export const cognitiveScope = "https://cognitiveservices.azure.com/.default";
type Credential = ClientCertificateCredential | ManagedIdentityCredential | AzureCliCredential;
let cached: Credential | undefined;

export function azureCredential(): Credential {
  if (cached) return cached;
  if (config.authMode === "certificate") {
    if (!config.tenantId || !config.clientId || !config.certificatePath) {
      throw new Error("Certificate authentication requires tenant ID, client ID, and a private PEM certificate path.");
    }
    cached = new ClientCertificateCredential(config.tenantId, config.clientId, config.certificatePath);
  } else if (config.authMode === "managed-identity") {
    cached = new ManagedIdentityCredential(config.clientId ? { clientId: config.clientId } : {});
  } else {
    cached = new AzureCliCredential(config.tenantId ? { tenantId: config.tenantId } : {});
  }
  return cached;
}

export async function cognitiveHeaders(): Promise<Record<string, string>> {
  const token = await azureCredential().getToken(cognitiveScope);
  if (!token) throw new Error("Entra authentication returned no Azure AI access token.");
  return { Authorization: `Bearer ${token.token}` };
}

export async function storageGatewayHeaders(): Promise<Record<string, string>> {
  if (config.authMode !== "certificate" || !config.storageGatewayScope) {
    throw new Error("Storage gateway requires explicit certificate authentication and its own scope.");
  }
  const token = await azureCredential().getToken(config.storageGatewayScope);
  if (!token) throw new Error("Entra authentication returned no storage gateway access token.");
  return { Authorization: `Bearer ${token.token}` };
}
