import { setTimeout as delay } from "node:timers/promises";

// Carries the HTTP status and Azure error code (never the body) so callers can react to specific failures.
export class AzureHttpError extends Error {
  constructor(readonly status: number, readonly code: string | undefined) {
    super(`Azure request failed (HTTP ${status}). Check Entra credentials, resource-scoped RBAC, resource region, deployment, quota, and storage network access.`);
  }
}

export async function requestJson(url: string, init: RequestInit = {}, retry = true, allowNotFound = false): Promise<unknown> {
  for (let attempt = 0; attempt < (retry ? 4 : 1); attempt++) {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(120_000) });
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
      await response.body?.cancel();
      await delay(Math.min(Math.max(wait, 1000), 120_000));
      continue;
    }
    let code: string | undefined;
    try {
      const body = await response.json() as { error?: { code?: unknown } };
      if (typeof body?.error?.code === "string") code = body.error.code.slice(0, 80);
    } catch { /* not JSON */ }
    throw new AzureHttpError(response.status, code);
  }
  throw new Error("Azure request exhausted retry attempts.");
}
