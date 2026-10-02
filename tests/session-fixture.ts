import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import type { Job } from "../src/domain.js";
import { JobRunner } from "../src/runner.js";
import { JobStore } from "../src/store.js";
import { createAccountFixture, loginFixture } from "./account-fixture.js";

export async function createSessionFixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const { accounts, user } = await createAccountFixture(root);
  const store = new JobStore(root);
  await store.init();
  const runner = new JobRunner(store);
  const server = createApp(store, runner, accounts).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const credentials = await loginFixture(base);
  return {
    root, store, runner, accounts, user, base, credentials,
    request(input: string | URL | Request, options: RequestInit = {}) {
      const headers = new Headers(options.headers);
      headers.set("Cookie", credentials.cookie);
      if (!["GET", "HEAD", "OPTIONS"].includes((options.method || "GET").toUpperCase())) {
        headers.set("X-CSRF-Token", credentials.csrfToken);
      }
      return fetch(input, { ...options, headers });
    },
    async save(job: Job) {
      accounts.assignJob(job.id, user.id);
      return store.save(job);
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      accounts.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
