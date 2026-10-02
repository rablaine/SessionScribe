import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { audioBlobPattern, expectedAudioUrl, maxGatewayBytes } from "./storage-contract.js";

export interface GatewayOptions {
  tenantId: string;
  audience: string;
  callerClientId: string;
  callerObjectId: string;
  storageAccountUrl: string;
  storageContainer: string;
}

export interface GatewayStorage {
  upload(blobName: string, body: Readable, signal: AbortSignal): Promise<void>;
  delete(blobName: string): Promise<void>;
  probe(): Promise<void>;
}

export class GatewayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type TokenVerifier = (token: string) => Promise<JWTPayload>;
const issuer = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/v2.0`;

export function createTokenVerifier(options: GatewayOptions): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${options.tenantId}/discovery/v2.0/keys`));
  return async token => (await jwtVerify(token, jwks, {
    algorithms: ["RS256"], issuer: issuer(options.tenantId), audience: options.audience,
    requiredClaims: ["exp", "iat", "iss", "aud", "azp", "oid"],
  })).payload;
}

async function authenticate(req: IncomingMessage, options: GatewayOptions, verify: TokenVerifier) {
  const authorization = req.headers.authorization;
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) {
    throw new GatewayError(401, "Authentication required.");
  }
  let claims: JWTPayload;
  try {
    claims = await verify(authorization.slice(7));
  } catch (error) {
    console.error("Gateway token verification failed:", error instanceof Error ? error.name : "Unknown verifier failure");
    throw new GatewayError(401, "Invalid access token.");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer(options.tenantId) || !audiences.includes(options.audience)) {
    throw new GatewayError(401, "Invalid access token.");
  }
  if (!Array.isArray(claims.roles) || !claims.roles.includes("Audio.Manage") ||
      claims.azp !== options.callerClientId || claims.oid !== options.callerObjectId) {
    throw new GatewayError(403, "Access denied.");
  }
}

export function createGatewayServer(options: GatewayOptions, storage: GatewayStorage, verify = createTokenVerifier(options)) {
  let transfers = 0;
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((error: unknown) => {
      console.error("Gateway request failed:", error);
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const status = error instanceof GatewayError ? error.status : 502;
      res.writeHead(status, {
        "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close",
        ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
      });
      res.end(JSON.stringify({ error: error instanceof GatewayError ? error.message : "Storage operation failed." }));
    });
  };
  const server = createServer(listener);
  server.on("checkContinue", listener);

  async function handle(req: IncomingMessage, res: ServerResponse) {
    await authenticate(req, options, verify);
    if (req.aborted || req.destroyed) throw new GatewayError(400, "Request disconnected.");
    if (req.url === "/health" && req.method === "GET") {
      await storage.probe();
      res.writeHead(204, { "Cache-Control": "no-store" }).end();
      return;
    }
    // Match the raw target: URL parsing/decoding would hide traversal and encoded separators.
    const blobName = req.url?.startsWith("/audio/") ? req.url.slice(7) : "";
    if (!audioBlobPattern.test(blobName)) throw new GatewayError(400, "Invalid audio path.");
    if (req.method !== "PUT" && req.method !== "DELETE") throw new GatewayError(405, "Method not allowed.");
    if (req.method === "PUT") {
      if (req.headers["content-type"] !== "audio/mpeg") throw new GatewayError(400, "Content-Type must be audio/mpeg.");
      const length = req.headers["content-length"];
      if (!length || !/^[1-9]\d*$/.test(length)) throw new GatewayError(400, "A positive Content-Length is required.");
      if (!Number.isSafeInteger(Number(length)) || Number(length) > maxGatewayBytes) {
        throw new GatewayError(413, "Audio exceeds 128 MiB.");
      }
    }
    if (transfers >= 2) throw new GatewayError(429, "Too many concurrent transfers.");
    transfers++;
    try {
      if (req.method === "DELETE") {
        await storage.delete(blobName);
        res.writeHead(204, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (req.headers.expect?.toLowerCase() === "100-continue") res.writeContinue();
      await upload(req, res, blobName, Number(req.headers["content-length"]));
      const audioUrl = expectedAudioUrl(options.storageAccountUrl, options.storageContainer, blobName);
      res.writeHead(201, { Location: audioUrl, "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ audioUrl }));
    } finally {
      transfers--;
    }
  }

  async function upload(req: IncomingMessage, res: ServerResponse, blobName: string, length: number) {
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) controller.abort(new GatewayError(400, "Upload disconnected."));
    };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    const limiter = createUploadLimiter(length);
    let streamFailure: unknown;
    const fail = (error: Error) => {
      streamFailure = error;
      controller.abort(error);
      limiter.destroy(error);
    };
    limiter.on("error", fail);
    req.once("error", fail);
    controller.signal.addEventListener("abort", () => {
      limiter.destroy(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Upload aborted."));
    }, { once: true });
    try {
      // Do not use pipeline(req, ...): it destroys the socket before a limit response can be sent.
      req.pipe(limiter);
      await storage.upload(blobName, limiter, controller.signal);
      if (streamFailure) throw streamFailure;
      if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) {
      controller.abort(error);
      try {
        await storage.delete(blobName);
      } catch (cleanupError) {
        console.error("Gateway partial upload cleanup failed:", cleanupError);
      }
      throw streamFailure ?? error;
    } finally {
      req.unpipe(limiter);
      limiter.destroy();
      req.off("error", fail);
      req.off("aborted", disconnect);
      res.off("close", disconnect);
    }
  }

  server.requestTimeout = 30 * 60_000;
  server.headersTimeout = 60_000;
  return server;
}

export function createUploadLimiter(length: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxGatewayBytes) callback(new GatewayError(413, "Audio exceeds 128 MiB."));
      else if (bytes > length) callback(new GatewayError(400, "Audio does not match Content-Length."));
      else callback(null, chunk);
    },
    flush(callback) {
      callback(bytes === length ? undefined : new GatewayError(400, "Audio does not match Content-Length."));
    },
  });
}
