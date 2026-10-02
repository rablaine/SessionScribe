import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { Accounts, clientKey } from "../src/accounts.js";
import { JobRunner } from "../src/runner.js";
import { JobStore } from "../src/store.js";
import { createDemo } from "../src/demo.js";
import { RetentionSweeper } from "../src/retention.js";
import { InstanceLock } from "../src/instance-lock.js";
import { publicJob } from "../src/domain.js";
import { DailyBackups } from "../src/backup.js";
import { fixtureEmail, fixturePassword } from "./account-fixture.js";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function call(port: number, method: string, url: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: url, headers }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("client keys group IPv6 by /64 and unwrap IPv4-mapped addresses", () => {
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey(undefined), "unknown");
});

test("public hosting: exact host/origin, HSTS, __Host- secure cookie, proxy-aware lockout, invite-only signup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scribe-public-"));
  const saved = { ...config };
  Object.assign(config, { publicOrigin: "https://scribe.example.test", trustProxy: 1 });
  const accounts = new Accounts({ databasePath: path.join(root, "accounts.sqlite"), publicOrigin: config.publicOrigin, openSignup: false });
  await accounts.bootstrapAdministrator(fixtureEmail, fixturePassword);
  const store = new JobStore(root);
  await store.init();
  const server = createApp(store, new JobRunner(store), accounts).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const host = "scribe.example.test";
  const json = { Host: host, "Content-Type": "application/json", Origin: "https://scribe.example.test" };
  const login = (password: string, ip: string) => call(port, "POST", "/api/auth/login",
    { ...json, "X-Forwarded-For": ip }, JSON.stringify({ email: fixtureEmail, password }));
  try {
    const session = await call(port, "GET", "/api/auth/session", { Host: host });
    assert.equal(session.status, 200);
    assert.equal(session.headers["strict-transport-security"], "max-age=31536000");
    assert.equal(JSON.parse(session.body).openSignup, false);
    assert.equal((await call(port, "GET", "/api/auth/session", { Host: "127.0.0.1" })).status, 403);
    assert.equal((await call(port, "GET", "/api/auth/session", { Host: "evil.example" })).status, 403);
    assert.equal((await call(port, "POST", "/api/auth/login", { ...json, Origin: "http://scribe.example.test" }, "{}")).status, 403);

    const ok = await login(fixturePassword, "198.51.100.7");
    assert.equal(ok.status, 200);
    const cookie = String(ok.headers["set-cookie"]);
    assert.match(cookie, /^__Host-scribe_session=/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);

    // An attacker at one address exhausts only their own (email, client) bucket.
    for (let attempt = 0; attempt < 10; attempt++) assert.equal((await login("wrong-password-1", "203.0.113.50")).status, 401);
    assert.equal((await login("wrong-password-1", "203.0.113.50")).status, 429);
    // Spoofing an extra X-Forwarded-For entry does not change the trusted client address.
    assert.equal((await login("wrong-password-1", "192.0.2.1, 203.0.113.50")).status, 429);
    assert.equal((await login(fixturePassword, "198.51.100.7")).status, 200);

    const register = await call(port, "POST", "/api/auth/register", json,
      JSON.stringify({ email: "stranger@example.test", password: "a-long-password-1" }));
    assert.equal(register.status, 403);
    assert.match(JSON.parse(register.body).error, /invitation only/);
  } finally {
    Object.assign(config, saved);
    await new Promise<void>(resolve => server.close(() => resolve()));
    accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("open signup caps the pending-request queue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scribe-pending-"));
  const accounts = new Accounts({ databasePath: path.join(root, "accounts.sqlite"), maxPendingAccounts: 2 });
  await accounts.bootstrapAdministrator(fixtureEmail, fixturePassword);
  const store = new JobStore(root);
  await store.init();
  const server = createApp(store, new JobRunner(store), accounts).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const name of ["one", "two", "three"]) {
      const response = await fetch(`${base}/api/auth/register`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${name}@example.test`, password: "a-long-password-1" }),
      });
      assert.equal(response.status, 202);
    }
    const db = (accounts as unknown as { db: { prepare(sql: string): { get(): unknown } } }).db;
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users WHERE status='pending'").get() as { n: number }).n, 2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("retention: expiry is enforced at request time, purged by the sweeper, and keeps transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scribe-retention-"));
  try {
    const store = new JobStore(root);
    await store.init();
    const created = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const legacy = await store.save({ ...createDemo(), demo: false, audioRetained: true, createdAt: created });
    const fresh = await store.save({ ...createDemo(), demo: false, audioRetained: true });
    const busy = await store.save({ ...createDemo(), demo: false, audioRetained: true, createdAt: created });
    for (const job of [legacy, fresh, busy]) {
      await writeFile(store.audioPath(job.id), "audio");
      await writeFile(path.join(store.directory(job.id), "waveform-v1.bin"), "peaks");
    }
    const sweeper = new RetentionSweeper(store, { retentionDays: 30, isBusy: id => id === busy.id });
    await sweeper.sweep();
    const purged = store.get(legacy.id)!;
    assert.equal(purged.audioRetained, false);
    assert.ok(purged.recordingPurgedAt);
    assert.equal(purged.recordingUploadedAt, created);
    assert.equal(publicJob(purged).recordingState, "expired");
    assert.equal(purged.segments.length, legacy.segments.length);
    await assert.rejects(readFile(store.audioPath(legacy.id)));
    await assert.rejects(readFile(path.join(store.directory(legacy.id), "waveform-v1.bin")));

    const kept = store.get(fresh.id)!;
    assert.equal(publicJob(kept).recordingState, "available");
    assert.equal(Date.parse(kept.recordingExpiresAt!) - Date.parse(kept.createdAt), 30 * 86_400_000);

    // Busy work defers the physical purge, but the expired recording is already unavailable to clients.
    const deferred = store.get(busy.id)!;
    assert.equal(deferred.audioRetained, true);
    assert.equal(publicJob(deferred).recordingState, "expired");
    assert.equal(publicJob(deferred).audioRetained, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("instance lock: a second instance waits until the first releases, and a lost lock is reported", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scribe-lock-"));
  try {
    const first = new InstanceLock(root, { host: "replica-a", pollMs: 20, heartbeatMs: 20 });
    await first.acquire();
    let acquired = false;
    const second = new InstanceLock(root, { host: "replica-b", pollMs: 20, heartbeatMs: 20 });
    const waiting = second.acquire().then(() => { acquired = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(acquired, false);
    await first.release();
    await waiting;
    assert.equal(acquired, true);

    let lost = false;
    const stale = new InstanceLock(root, { host: "replica-c", staleMs: 60_000, pollMs: 20, heartbeatMs: 20, onLost: () => { lost = true; } });
    // Simulate takeover by writing another holder's record directly.
    await writeFile(path.join(root, ".instance.lock"), JSON.stringify({ id: "other", host: "replica-d", heartbeatAt: 0 }));
    await stale.acquire();
    await writeFile(path.join(root, ".instance.lock"), JSON.stringify({ id: "intruder", host: "replica-e", heartbeatAt: Date.now() }));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(lost, true);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daily backups copy only the accounts database and keep fourteen days", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scribe-backup-"));
  const accounts = new Accounts({ databasePath: path.join(root, "accounts.sqlite"), journalMode: "DELETE" });
  try {
    await accounts.bootstrapAdministrator(fixtureEmail, fixturePassword);
    const backups = new DailyBackups(accounts, path.join(root, "backups"));
    for (let day = 1; day <= 16; day++) await backups.run(new Date(Date.UTC(2026, 0, day)));
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(path.join(root, "backups"))).sort();
    assert.equal(files.length, 14);
    assert.equal(files[0], "accounts-2026-01-03.sqlite");
    const copy = new Accounts({ databasePath: path.join(root, "backups", files.at(-1)!) });
    try { assert.equal(copy.isActiveUser("missing"), false); } finally { copy.close(); }
  } finally {
    accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("operator CLI methods issue invitation/reset links and delete only session-free non-admin accounts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scribe-operator-"));
  const accounts = new Accounts({ databasePath: path.join(root, "accounts.sqlite"), publicOrigin: "https://scribe.example.test" });
  try {
    const setup = await accounts.operatorBootstrapLink(fixtureEmail);
    assert.match(setup.url, /#reset=/);
    assert.ok(Date.parse(setup.expiresAt) - Date.now() > 23 * 3_600_000);
    await assert.rejects(accounts.operatorBootstrapLink("second@example.test"), /already exists/);
    const invite = accounts.operatorInvite(" Friend@Example.test ");
    assert.match(invite.url, /^https:\/\/scribe\.example\.test\/#invite=[A-Za-z0-9_-]{43}&email=friend%40example\.test$/);
    assert.match(accounts.operatorResetLink(fixtureEmail).url, /^https:\/\/scribe\.example\.test\/#reset=[A-Za-z0-9_-]{43}$/);
    assert.throws(() => accounts.operatorResetLink("nobody@example.test"), /No active or pending/);
    assert.throws(() => accounts.operatorInvite(fixtureEmail), /not available/);
    assert.throws(() => accounts.operatorDeleteUser(fixtureEmail), /Administrator/);
    const local = new Accounts({ databasePath: path.join(root, "other.sqlite") });
    try { assert.throws(() => local.operatorInvite("x@example.test"), /APP_PUBLIC_ORIGIN/); } finally { local.close(); }
  } finally {
    accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a remembered device keeps signing in while strangers exhaust the account-wide failure limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scribe-device-"));
  const accounts = new Accounts({ databasePath: path.join(root, "accounts.sqlite") });
  await accounts.bootstrapAdministrator(fixtureEmail, fixturePassword);
  const store = new JobStore(root);
  await store.init();
  const saved = { ...config };
  Object.assign(config, { publicOrigin: "", trustProxy: 0 });
  const server = createApp(store, new JobRunner(store), accounts).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = (password: string, cookie = "") => fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ email: fixtureEmail, password }),
  });
  try {
    const first = await login(fixturePassword);
    const device = first.headers.getSetCookie().find(value => value.startsWith("scribe_device="))!.split(";")[0]!;
    assert.ok(device);
    // Simulate a distributed attacker filling the account-wide bucket (50 failures/hour).
    const db = (accounts as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db;
    const { createHash } = await import("node:crypto");
    db.prepare("INSERT OR REPLACE INTO rate_limits(key,count,expiresAt) VALUES (?,?,?)")
      .run(`login-fail:${createHash("sha256").update(fixtureEmail).digest("hex")}`, 50, Date.now() + 3_600_000);
    assert.equal((await login(fixturePassword)).status, 429);
    assert.equal((await login(fixturePassword, device)).status, 200);
    assert.equal((await login("wrong-password-1", "scribe_device=" + "A".repeat(43))).status, 429);
  } finally {
    Object.assign(config, saved);
    await new Promise<void>(resolve => server.close(() => resolve()));
    accounts.close();
    await rm(root, { recursive: true, force: true });
  }
});