import { setTimeout as delay } from "node:timers/promises";

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
    await response.body?.cancel();
    throw new Error(`Azure request failed (HTTP ${response.status}). Check Entra credentials, resource-scoped RBAC, resource region, deployment, quota, and storage network access.`);
  }
  throw new Error("Azure request exhausted retry attempts.");
}
