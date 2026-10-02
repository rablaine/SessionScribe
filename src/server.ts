import { config } from "./config.js";
import { createApp } from "./app.js";
import { activeLaughterStatuses, activeStatuses, JobRunner } from "./runner.js";
import { JobStore } from "./store.js";
import { createServer } from "node:http";
import path from "node:path";
import { Accounts } from "./accounts.js";

const store = new JobStore(config.dataDir);
await store.init();
const runner = new JobRunner(store);
const accounts = new Accounts({
  databasePath: path.join(config.dataDir, "accounts.sqlite"),
  publicOrigin: config.publicOrigin || undefined,
  adminEmail: config.adminEmail || undefined,
});
const app = createApp(store, runner, accounts);
const server = createServer(app);
server.once("listening", () => {
  console.log(`Session Scribe: http://${config.host}:${config.port}`);
  console.log("Single-instance SQLite accounts enabled. Public hosting remains disabled; deployment requires HTTPS, persistent storage, backups, and capacity limits.");
  for (const job of store.list()) {
    const operation = activeStatuses.has(job.status) ? "process" :
      activeLaughterStatuses.has(job.laughter.status) ? "laughter" : undefined;
    if (!operation) continue;
    if (!accounts.jobOwner(job.id)) {
      console.warn(`Session ${job.id} was not resumed because its ownership record is missing.`);
    } else if (operation === "process") {
      runner.enqueue(job.id);
    } else {
      runner.enqueueLaughter(job.id);
    }
  }
});
server.requestTimeout = 30 * 60_000;
server.on("error", error => {
  console.error("Server could not listen:", error.message);
  accounts.close();
  process.exitCode = 1;
});
server.listen({ port: config.port, host: config.host });
