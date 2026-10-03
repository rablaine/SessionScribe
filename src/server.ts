import { config } from "./config.js";
import { createApp } from "./app.js";
import { activeLaughterStatuses, activeStatuses, JobRunner } from "./runner.js";
import { JobStore } from "./store.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Accounts } from "./accounts.js";
import { InstanceLock } from "./instance-lock.js";
import { RetentionSweeper } from "./retention.js";
import { DailyBackups } from "./backup.js";
import { StageTimings } from "./timings.js";
import type { Uploads } from "./uploads.js";

// Listen immediately so the platform sees a live process, but answer 503 until this instance owns DATA_DIR.
let handler = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: "Session Scribe is starting. Try again in a few seconds." }));
};
const server = createServer((req, res) => handler(req, res));
server.headersTimeout = 60_000;
server.requestTimeout = 5 * 60_000;
server.keepAliveTimeout = 65_000;
server.on("error", error => {
  console.error("Server could not listen:", error.message);
  process.exit(1);
});
server.listen({ port: config.port, host: config.host }, () => {
  console.log(`Session Scribe listening on http://${config.host}:${config.port}${config.publicOrigin ? ` (public origin ${config.publicOrigin})` : ""}`);
});

await mkdir(config.dataDir, { recursive: true });
const lock = new InstanceLock(config.dataDir, {
  log: message => console.log(message),
  onLost: () => {
    console.error("Lost the data directory lock (another instance took over or storage is unreachable). Exiting to avoid concurrent writes.");
    process.exit(1);
  },
});
await lock.acquire();

// Restore drop-in: copy a backup to DATA_DIR/restore-accounts.sqlite and restart; it replaces the live DB once.
const databasePath = path.join(config.dataDir, "accounts.sqlite");
const restoreFile = path.join(config.dataDir, "restore-accounts.sqlite");
if (existsSync(restoreFile)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    if (existsSync(databasePath + suffix)) await rename(databasePath + suffix, `${databasePath}${suffix}.before-restore-${stamp}`);
  }
  await rename(restoreFile, databasePath);
  console.log(`Accounts database restored from restore-accounts.sqlite; the previous copy was kept with suffix .before-restore-${stamp}.`);
}

const store = new JobStore(config.dataDir);
await store.init();
const runner = new JobRunner(store);
runner.timings = StageTimings.inDirectory(config.dataDir);
const accounts = new Accounts({
  databasePath,
  publicOrigin: config.publicOrigin || undefined,
  adminEmail: config.adminEmail || undefined,
  journalMode: config.sqliteJournalMode,
  openSignup: config.openSignup,
});
runner.canProcess = id => {
  const owner = accounts.jobOwner(id);
  return !!owner && accounts.isActiveUser(owner);
};
runner.chargeExtraAudio = (id, extraMs) => {
  const owner = accounts.jobOwner(id);
  if (!owner) throw new Error("The session owner could not be determined.");
  accounts.consumeQuota(owner, "audio-ms", extraMs, config.quotas.audioMs,
    "The decoded recording is longer than its file header claimed, and the extra audio exceeds your daily audio limit.");
};
const app = createApp(store, runner, accounts);
const retention = new RetentionSweeper(store, {
  retentionDays: config.retentionDays,
  isBusy: id => (app.locals.isRecordingBusy as (id: string) => boolean)(id),
});
const backups = new DailyBackups(accounts, path.join(config.dataDir, "backups"));
handler = app;

for (const job of store.list()) {
  const operation = activeStatuses.has(job.status) ? "process" :
    activeLaughterStatuses.has(job.laughter.status) ? "laughter" : undefined;
  if (!operation) continue;
  if (!accounts.jobOwner(job.id)) {
    console.warn(`Session ${job.id} was not resumed because its ownership record is missing.`);
  } else if (operation === "process") {
    if (job.queuedOperation === "recap") runner.enqueueRecap(job.id);
    else runner.enqueue(job.id);
  } else {
    runner.enqueueLaughter(job.id);
  }
}
retention.start();
backups.start();
const uploadCleanup = setInterval(() => void (app.locals.uploads as Uploads).cleanup().catch(() => {}), 30 * 60_000);
uploadCleanup.unref();
console.log(`Ready. Data directory owned by this instance; recording retention ${config.retentionDays ? `${config.retentionDays} days` : "disabled"}.`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; stopping new work and releasing the data directory.`);
  // Storage can hang (e.g. a broken network mount); never outlive the platform's grace period.
  setTimeout(() => process.exit(0), 25_000).unref();
  runner.stop();
  retention.stop();
  backups.stop();
  clearInterval(uploadCleanup);
  server.close();
  const deadline = Date.now() + 20_000;
  while (runner.inCriticalSection && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  try { accounts.close(); } catch { /* already closed */ }
  await lock.release().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
