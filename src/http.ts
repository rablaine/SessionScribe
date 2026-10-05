import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { diagnosticToken, logDiagnostic, type HttpMetadata, type ModelContext } from "./diagnostics.js";

// Carries the HTTP status and Azure error code (never the body) so callers can react to specific failures.
export class AzureHttpError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, readonly requestId?: string) {
    super(`Azure request failed (HTTP ${status}). Check Entra credentials, resource-scoped RBAC, resource region, deployment, quota, and storage network access.`);
  }
}

type RequestDiagnostics = { context?: ModelContext; callId?: string; onResponse?: (metadata: HttpMetadata) => void };

export async function requestJson(url: string, init: RequestInit = {}, retry = true, allowNotFound = false, diagnostics: RequestDiagnostics = {}): Promise<unknown> {
  const callId = diagnostics.callId ?? randomUUID();
  for (let attempt = 0; attempt < (retry ? 4 : 1); attempt++) {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      logDiagnostic({ ...diagnostics.context, event: "azure_http_error", callId, httpAttempt: attempt + 1,
        durationMs: Date.now() - started, errorKind: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network" });
      throw error;
    }
    const requestId = diagnosticToken(response.headers.get("apim-request-id")) ??
      diagnosticToken(response.headers.get("x-ms-request-id")) ?? diagnosticToken(response.headers.get("x-request-id"));
    const metadata = { status: response.status, requestId };
    diagnostics.onResponse?.(metadata);
    if (allowNotFound && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.ok) {
      if (response.status === 204) return null;
      return response.json();
    }
    if (retry && attempt < 3 && (response.status === 429 || response.status >= 500)) {
      const header = response.headers.get("retry-after");
      const seconds = header ? Number(header) : NaN;
      const wait = Number.isFinite(seconds) ? seconds * 1000 : 2000 * 2 ** attempt;
      const retryDelayMs = Math.min(Math.max(wait, 1000), 120_000);
      logDiagnostic({ ...diagnostics.context, event: "azure_http_retry", callId, ...metadata,
        httpAttempt: attempt + 1, durationMs: Date.now() - started, retryDelayMs });
      await response.body?.cancel();
      await delay(retryDelayMs);
      continue;
    }
    let code: string | undefined;
    try {
      const body = await response.json() as { error?: { code?: unknown } };
      if (typeof body?.error?.code === "string") code = body.error.code.slice(0, 80);
    } catch { /* not JSON */ }
    logDiagnostic({ ...diagnostics.context, event: "azure_http_error", callId, ...metadata,
      httpAttempt: attempt + 1, durationMs: Date.now() - started, errorKind: "http", errorCode: diagnosticToken(code) });
    throw new AzureHttpError(response.status, code, requestId);
  }
  throw new Error("Azure request exhausted retry attempts.");
}
