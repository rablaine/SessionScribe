import "dotenv/config";
import { z } from "zod";
import { createGatewayServer } from "./gateway.js";
import { createManagedIdentityStorage } from "./gateway-storage.js";

const env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  GATEWAY_TENANT_ID: z.uuid(),
  GATEWAY_AUDIENCE: z.uuid(),
  GATEWAY_CALLER_CLIENT_ID: z.uuid(),
  GATEWAY_CALLER_OBJECT_ID: z.uuid(),
  AZURE_STORAGE_ACCOUNT_URL: z.url(),
  AZURE_STORAGE_CONTAINER: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
}).parse(process.env);
const account = new URL(env.AZURE_STORAGE_ACCOUNT_URL);
if (account.protocol !== "https:" || !account.hostname.endsWith(".blob.core.windows.net") ||
    account.pathname !== "/" || account.username || account.password || account.port || account.search || account.hash) {
  throw new Error("Gateway storage must be an HTTPS Azure Blob account root.");
}
const options = {
  tenantId: env.GATEWAY_TENANT_ID,
  audience: env.GATEWAY_AUDIENCE,
  callerClientId: env.GATEWAY_CALLER_CLIENT_ID,
  callerObjectId: env.GATEWAY_CALLER_OBJECT_ID,
  storageAccountUrl: account.origin,
  storageContainer: env.AZURE_STORAGE_CONTAINER,
};
const server = createGatewayServer(options, createManagedIdentityStorage(options));
server.once("listening", () => console.log(`Authenticated storage gateway listening on port ${env.PORT}.`));
server.on("error", error => {
  console.error("Gateway could not listen:", error.message);
  process.exitCode = 1;
});
server.listen(env.PORT, "0.0.0.0");
