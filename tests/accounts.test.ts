import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { Accounts, type AccountUser } from "../src/accounts.js";
import { createAccountFixture, fixtureEmail, fixturePassword, loginFixture } from "./account-fixture.js";

const password = "An-excellent-test-password-2026";
const replacement = "A-new-excellent-password-2026";

test("eight-character passwords work for bootstrap, signup, invitations, login and reset; seven are rejected", async () => {
  const f = await fixture();
  const bootstrap = new Accounts({ databasePath: path.join(f.directory, "bootstrap.sqlite") });
  try {
    await assert.rejects(bootstrap.bootstrapAdministrator("short@example.test", "1234567"));
    const administrator = await bootstrap.bootstrapAdministrator("eight@example.test", "12345678");
    assert.equal(administrator.role, "admin");
    assert.equal((await f.request("/auth/register", "POST", {
      email: "short@example.test", password: "1234567",
    })).status, 400);
    const signup = await f.request("/auth/register", "POST", {
      email: "eight@example.test", password: "12345678",
    });
    assert.equal(signup.status, 202);
    assert.equal((await signup.json()).user.status, "pending");
    assert.equal((await f.request("/auth/login", "POST", {
      email: "eight@example.test", password: "12345678",
    })).status, 200);
    const invitation = await f.invite("invited-eight@example.test");
    assert.equal((await f.request("/auth/register", "POST", {
      email: "invited-eight@example.test", password: "1234567", invitationToken: invitation.token,
    })).status, 400);
    const invited = await f.request("/auth/register", "POST", {
      email: "invited-eight@example.test", password: "12345678", invitationToken: invitation.token,
    });
    assert.equal(invited.status, 202);
    const user = (await invited.json()).user;
    assert.equal(user.status, "active");
    const reset = await f.request(`/admin/users/${user.id}/reset-link`, "POST", {}, f.admin.headers);
    assert.equal(reset.status, 200);
    const resetToken = new URLSearchParams(new URL((await reset.json()).url).hash.slice(1)).get("reset");
    assert.equal((await f.request("/auth/reset", "POST", {
      token: resetToken, password: "7654321",
    })).status, 400);
    assert.equal((await f.request("/auth/reset", "POST", {
      token: resetToken, password: "87654321",
    })).status, 200);
    assert.equal((await f.request("/auth/login", "POST", {
      email: user.email, password: "87654321",
    })).status, 200);
  } finally {
    bootstrap.close();
    await f.cleanup();
  }
});

async function fixture() {
  const directory = await mkdtemp(path.resolve("tests", ".accounts-"));
  const created = await createAccountFixture(directory);
  const app = express();
  app.use("/api", created.accounts.router);
  app.use("/api/private", created.accounts.sessionMiddleware, created.accounts.requireActive, (_req, res) => res.json({ ok: true }));
  app.post("/api/upload-fixture", created.accounts.sessionMiddleware, created.accounts.requireActive, (_req, res) => res.sendStatus(204));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = await loginFixture(base);
  const request = (url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api${url}`, {
      method, headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const db = () => new DatabaseSync(path.join(directory, "accounts.sqlite"));
  async function signup(email: string) {
    const response = await request("/auth/register", "POST", { email, password });
    assert.equal(response.status, 202);
    const body = await response.json() as { user: AccountUser; csrfToken: string };
    return {
      user: body.user,
      headers: { Cookie: response.headers.get("set-cookie")!.split(";")[0]!, "X-CSRF-Token": body.csrfToken },
    };
  }
  async function invite(email: string) {
    assert.equal((await request("/admin/whitelist", "POST", { email }, admin.headers)).status, 200);
    const response = await request("/admin/invitations", "POST", { email }, admin.headers);
    assert.equal(response.status, 200);
    const body = await response.json() as { url: string; expiresAt: string };
    return { ...body, token: new URLSearchParams(new URL(body.url).hash.slice(1)).get("invite")! };
  }
  return {
    ...created, directory, base, admin, request, db, signup, invite,
    async cleanup() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      created.accounts.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("account session cookies, normalization, password policy, rotation, CSRF and logout", async () => {
  const f = await fixture();
  try {
    const anonymous = await f.request("/auth/session");
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    assert.deepEqual(await anonymous.json(), { user: null, csrfToken: null, setupRequired: false });
    const response = await f.request("/auth/login", "POST", { email: ` ${fixtureEmail.toUpperCase()} `, password: fixturePassword });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.doesNotMatch(cookie, /Secure/i);
    const body = await response.json();
    assert.equal(body.user.email, fixtureEmail);
    assert.equal(body.user.password, undefined);
    const sessionHeaders = { Cookie: cookie.split(";")[0]!, "X-CSRF-Token": body.csrfToken };
    assert.equal((await f.request("/private", "POST", {}, { Cookie: sessionHeaders.Cookie })).status, 403);
    assert.equal((await f.request("/private", "POST", {}, sessionHeaders)).status, 200);
    const multipart = new FormData();
    multipart.set("audio", new Blob(["test"]), "test.mp3");
    assert.equal((await fetch(`${f.base}/api/upload-fixture`, { method: "POST", headers: sessionHeaders, body: multipart })).status, 204);
    assert.equal((await f.request("/auth/logout", "POST", {}, { Cookie: sessionHeaders.Cookie })).status, 403);
    const rotated = await f.request("/auth/login", "POST", { email: fixtureEmail, password: fixturePassword }, sessionHeaders);
    assert.equal(rotated.status, 200);
    assert.equal((await (await f.request("/auth/session", "GET", undefined, sessionHeaders)).json()).user, null);
    const rotatedBody = await rotated.json();
    const newHeaders = { Cookie: rotated.headers.get("set-cookie")!.split(";")[0]!, "X-CSRF-Token": rotatedBody.csrfToken };
    assert.equal((await f.request("/auth/logout", "POST", {}, newHeaders)).status, 204);
    assert.equal((await f.request("/private", "GET", undefined, newHeaders)).status, 401);
    for (const invalid of ["short", "x".repeat(129)]) {
      assert.equal((await f.request("/auth/register", "POST", { email: "invalid@example.test", password: invalid })).status, 400);
    }
    assert.equal((await fetch(`${f.base}/api/auth/login`, { method: "POST", body: "{}" })).status, 415);
    assert.equal((await f.request("/auth/login", "POST", {}, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await f.request("/auth/login", "POST", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await fetch(`${f.base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    })).status, 400);
  } finally { await f.cleanup(); }
});

test("ordinary signup is pending even whitelisted; approval requires confirmed identity and no public privilege escalation", async () => {
  const f = await fixture();
  try {
    const email = "pending@example.test";
    await f.request("/admin/whitelist", "POST", { email }, f.admin.headers);
    const pending = await f.signup(email);
    assert.equal(pending.user.status, "pending");
    assert.equal(pending.user.verificationMethod, null);
    assert.equal((await f.request("/private", "GET", undefined, pending.headers)).status, 403);
    assert.equal((await f.request("/admin/users", "GET", undefined, pending.headers)).status, 403);
    assert.equal((await f.request("/auth/session", "GET", undefined, pending.headers)).status, 200);
    assert.equal((await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "active" }, f.admin.headers)).status, 400);
    const approved = await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "active", confirmedIdentity: true }, f.admin.headers);
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).user.verificationMethod, "manual");
    assert.equal((await f.request("/private", "GET", undefined, pending.headers)).status, 200);
    assert.equal((await f.request("/admin/users", "GET", undefined, pending.headers)).status, 403);
    assert.equal((await f.request("/auth/register", "POST", { email: "attacker@example.test", password, role: "admin", status: "active" })).status, 400);
    for (const status of ["rejected", "suspended", "active"]) {
      assert.equal((await f.request(`/admin/users/${f.user.id}`, "PATCH", { status, confirmedIdentity: true }, f.admin.headers)).status, 403);
    }
    await f.request(`/admin/whitelist/${email}`, "DELETE", undefined, f.admin.headers);
    assert.equal((await f.request("/private", "GET", undefined, pending.headers)).status, 200);
  } finally { await f.cleanup(); }
});

test("duplicate signup and login failures are generic; reserved administrator cannot register", async () => {
  const f = await fixture();
  try {
    await f.signup("exists@example.test");
    const duplicate = await f.request("/auth/register", "POST", { email: "EXISTS@example.test", password: replacement });
    const adminDuplicate = await f.request("/auth/register", "POST", { email: fixtureEmail, password: replacement });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.headers.get("set-cookie"), null);
    assert.deepEqual(await duplicate.json(), await adminDuplicate.json());
    const missing = await f.request("/auth/login", "POST", { email: "missing@example.test", password });
    const wrong = await f.request("/auth/login", "POST", { email: fixtureEmail, password });
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(await missing.json(), await wrong.json());
    await assert.rejects(() => f.accounts.bootstrapAdministrator("another@example.test", password), /already exists/);
    const reserved = new Accounts({ databasePath: path.join(f.directory, "reserved.sqlite"), adminEmail: "reserved@example.test" });
    try {
      await assert.rejects(() => reserved.bootstrapAdministrator("not-reserved@example.test", password), /reservation/);
      const reservedApp = express().use("/api", reserved.router);
      const server = reservedApp.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/register`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "reserved@example.test", password }),
        });
        assert.equal(response.status, 202);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal((await response.json()).user, undefined);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
      assert.equal((await reserved.bootstrapAdministrator("reserved@example.test", password)).role, "admin");
    } finally { reserved.close(); }
  } finally { await f.cleanup(); }
});

test("bound one-use invitation is atomic, requires whitelist, expires, and never activates an arbitrary email", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/admin/invitations", "POST", { email: "absent@example.test" }, f.admin.headers)).status, 400);
    assert.equal((await f.request("/admin/whitelist", "POST", { email: "unauthorized@example.test" })).status, 401);
    assert.equal((await f.request("/admin/whitelist", "POST", { email: "no-csrf@example.test" }, { Cookie: f.admin.cookie })).status, 403);
    const invitation = await f.invite("invited@example.test");
    assert.equal(new URL(invitation.url).search, "");
    assert.match(new URL(invitation.url).hash, /^#invite=[A-Za-z0-9_-]{43}&email=invited%40example.test$/);
    assert.equal((await f.request("/auth/register", "POST", { email: "wrong@example.test", password, invitationToken: invitation.token })).status, 400);
    const concurrent = await Promise.all([1, 2].map(() => f.request("/auth/register", "POST", {
      email: "invited@example.test", password, invitationToken: invitation.token,
    })));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [202, 400]);
    const accepted = await concurrent.find(response => response.status === 202)!.json();
    assert.equal(accepted.user.status, "active");
    assert.equal(accepted.user.verificationMethod, "invitation");
    assert.equal((await f.request("/admin/invitations", "POST", { email: "invited@example.test" }, f.admin.headers)).status, 400);
    const expired = await f.invite("expired@example.test");
    const db = f.db();
    db.prepare("UPDATE links SET expiresAt=0 WHERE email=?").run("expired@example.test");
    db.close();
    assert.equal((await f.request("/auth/register", "POST", { email: "expired@example.test", password, invitationToken: expired.token })).status, 400);
    const removed = await f.invite("removed@example.test");
    assert.equal((await f.request("/admin/whitelist/removed@example.test", "DELETE", undefined, f.admin.headers)).status, 204);
    assert.equal((await f.request("/auth/register", "POST", { email: "removed@example.test", password, invitationToken: removed.token })).status, 400);
  } finally { await f.cleanup(); }
});

test("invitation replaces pending spam password and revokes old sessions", async () => {
  const f = await fixture();
  try {
    const pending = await f.signup("victim@example.test");
    const invitation = await f.invite("victim@example.test");
    const accepted = await f.request("/auth/register", "POST", {
      email: "victim@example.test", password: replacement, invitationToken: invitation.token,
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).user.id, pending.user.id);
    assert.equal((await f.request("/private", "GET", undefined, pending.headers)).status, 401);
    assert.equal((await f.request("/auth/login", "POST", { email: "victim@example.test", password })).status, 401);
    const user = await loginFixture(f.base, "victim@example.test", replacement);
    assert.equal((await f.request("/private", "GET", undefined, user.headers)).status, 200);
  } finally { await f.cleanup(); }
});

test("reset links expire and are single-use; reset revokes every session and never logs in", async () => {
  const f = await fixture();
  try {
    const pending = await f.signup("reset@example.test");
    await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "active", confirmedIdentity: true }, f.admin.headers);
    const second = await loginFixture(f.base, "reset@example.test", password);
    const link = await (await f.request(`/admin/users/${pending.user.id}/reset-link`, "POST", {}, f.admin.headers)).json();
    assert.equal(new URL(link.url).search, "");
    const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get("reset")!;
    const response = await f.request("/auth/reset", "POST", { token, password: replacement });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie")!.includes("scribe_session=;"), true);
    for (const headers of [pending.headers, second.headers]) {
      assert.equal((await f.request("/private", "GET", undefined, headers)).status, 401);
    }
    assert.equal((await f.request("/auth/reset", "POST", { token, password })).status, 400);
    assert.equal((await f.request("/auth/login", "POST", { email: "reset@example.test", password })).status, 401);
    assert.equal((await loginFixture(f.base, "reset@example.test", replacement)).csrfToken.length, 43);
    const expired = await (await f.request(`/admin/users/${pending.user.id}/reset-link`, "POST", {}, f.admin.headers)).json();
    const db = f.db();
    db.prepare("UPDATE links SET expiresAt=0 WHERE kind='reset'").run();
    db.close();
    assert.equal((await f.request("/auth/reset", "POST", {
      token: new URLSearchParams(new URL(expired.url).hash.slice(1)).get("reset"), password,
    })).status, 400);
  } finally { await f.cleanup(); }
});

test("suspension/rejection revoke sessions and links and current state gates requests", async () => {
  const f = await fixture();
  try {
    const pending = await f.signup("suspended@example.test");
    await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "active", confirmedIdentity: true }, f.admin.headers);
    const resetLink = await (await f.request(`/admin/users/${pending.user.id}/reset-link`, "POST", {}, f.admin.headers)).json();
    assert.equal((await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "suspended" }, f.admin.headers)).status, 200);
    assert.equal((await f.request("/private", "GET", undefined, pending.headers)).status, 401);
    assert.equal((await f.request("/auth/login", "POST", { email: pending.user.email, password })).status, 401);
    assert.equal((await f.request("/auth/reset", "POST", {
      token: new URLSearchParams(new URL(resetLink.url).hash.slice(1)).get("reset"), password: replacement,
    })).status, 400);
    assert.equal((await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "active" }, f.admin.headers)).status, 400);
    await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "active", confirmedIdentity: true }, f.admin.headers);
    assert.equal((await f.request("/private", "GET", undefined, pending.headers)).status, 401);
    const fresh = await loginFixture(f.base, pending.user.email, password);
    assert.equal((await f.request("/private", "GET", undefined, fresh.headers)).status, 200);
    await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "rejected" }, f.admin.headers);
    assert.equal((await f.request("/private", "GET", undefined, fresh.headers)).status, 401);
  } finally { await f.cleanup(); }
});

test("SQLite hashes credentials, survives restart, persists limits/whitelist/owners, and leaves unowned jobs inaccessible", async () => {
  const f = await fixture();
  let reopened: Accounts | undefined;
  try {
    f.accounts.assignJob("job-test", f.user.id);
    f.accounts.assignJob("job-test", f.user.id);
    assert.equal(f.accounts.ownsJob(f.user.id, "unowned"), false);
    assert.equal(f.accounts.ownsJob("someone-else", "job-test"), false);
    const pending = await f.signup("durable@example.test");
    assert.throws(() => f.accounts.assignJob("job-test", pending.user.id), /approval/);
    assert.equal(f.accounts.isActiveUser(pending.user.id), false);
    await f.request(`/admin/users/${pending.user.id}`, "PATCH", { status: "active", confirmedIdentity: true }, f.admin.headers);
    assert.equal(f.accounts.isActiveUser(pending.user.id), true);
    assert.throws(() => f.accounts.assignJob("job-test", pending.user.id), /already has an owner/);
    await f.request("/admin/whitelist", "POST", { email: "durable@example.test" }, f.admin.headers);
    const invitation = await f.invite("new@example.test");
    const db = f.db();
    const storedUser = db.prepare("SELECT password FROM users WHERE id=?").get(f.user.id) as { password: string };
    assert.match(storedUser.password, /^scrypt-v1\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    const sessions = db.prepare("SELECT hash FROM sessions").all();
    assert.ok(sessions.every(row => row.hash !== f.admin.cookie.split("=")[1]));
    assert.equal(db.prepare("SELECT hash FROM links WHERE hash=?").get(invitation.token), undefined);
    const audit = JSON.stringify(db.prepare("SELECT * FROM audit").all());
    assert.doesNotMatch(audit, new RegExp(invitation.token));
    assert.equal(audit.includes(fixturePassword), false);
    db.close();
    reopened = new Accounts({ databasePath: path.join(f.directory, "accounts.sqlite") });
    assert.equal(reopened.ownsJob(f.user.id, "job-test"), true);
    const app = express().use("/api", reopened.router);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const session = await (await fetch(`${base}/api/auth/session`, { headers: f.admin.headers })).json();
      assert.equal(session.user.id, f.user.id);
      assert.equal(session.csrfToken, f.admin.csrfToken);
      const entries = await (await fetch(`${base}/api/admin/whitelist`, { headers: f.admin.headers })).json();
      assert.ok(entries.entries.some((entry: { email: string }) => entry.email === "durable@example.test"));
      const accepted = await fetch(`${base}/api/auth/register`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new@example.test", password, invitationToken: invitation.token }),
      });
      assert.equal(accepted.status, 202);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    reopened.releaseJob("job-test");
    reopened.releaseJob("job-test");
    assert.equal(f.accounts.ownsJob(f.user.id, "job-test"), false);
    await assert.rejects(() => reopened!.bootstrapAdministrator("new-admin@example.test", password), /already exists/);
  } finally { reopened?.close(); await f.cleanup(); }
});

test("login throttling is explicit and durable across account instances", async () => {
  const f = await fixture();
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      assert.equal((await f.request("/auth/login", "POST", { email: "throttled@example.test", password })).status, 401);
    }
    assert.equal((await f.request("/auth/login", "POST", { email: "throttled@example.test", password })).status, 429);
    const db = f.db();
    assert.ok((db.prepare("SELECT count(*) AS n FROM rate_limits").get() as { n: number }).n > 0);
    db.close();
    const other = new Accounts({ databasePath: path.join(f.directory, "accounts.sqlite") });
    const server = express().use("/api", other.router).listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "throttled@example.test", password }),
      });
      assert.equal(response.status, 429);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      other.close();
    }
  } finally { await f.cleanup(); }
});

test("KDF queue is bounded, and registration/reset abuse is rate-limited before expensive work", async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      f.request("/auth/login", "POST", { email: `queue-${index}@example.test`, password })));
    assert.ok(responses.some(response => response.status === 429));
    assert.ok(responses.every(response => response.status === 401 || response.status === 429));
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.equal((await f.request("/auth/register", "POST", {})).status, 400);
    }
    assert.equal((await f.request("/auth/register", "POST", {})).status, 429);
    for (let attempt = 0; attempt < 30; attempt++) {
      assert.equal((await f.request("/auth/reset", "POST", {})).status, 400);
    }
    assert.equal((await f.request("/auth/reset", "POST", {})).status, 429);
  } finally { await f.cleanup(); }
});

test("expired sessions are unusable and pending users can logout", async () => {
  const f = await fixture();
  try {
    const pending = await f.signup("expiry@example.test");
    assert.equal((await f.request("/auth/logout", "POST", {}, pending.headers)).status, 204);
    const session = await loginFixture(f.base, pending.user.email, password);
    const db = f.db();
    db.prepare("UPDATE sessions SET expiresAt=0 WHERE userId=?").run(pending.user.id);
    db.close();
    const response = await f.request("/auth/session", "GET", undefined, session.headers);
    assert.equal((await response.json()).user, null);
    assert.match(response.headers.get("set-cookie")!, /scribe_session=;/);
    assert.equal((await f.request("/private", "GET", undefined, session.headers)).status, 401);
  } finally { await f.cleanup(); }
});

test("configured HTTPS emits secure cookies; non-loopback HTTP public origins are rejected", async () => {
  const directory = await mkdtemp(path.resolve("tests", ".accounts-"));
  assert.throws(() => new Accounts({ databasePath: path.join(directory, "invalid.sqlite"), publicOrigin: "http://example.test" }), /HTTPS/);
  const accounts = new Accounts({ databasePath: path.join(directory, "secure.sqlite"), publicOrigin: "https://scribe.example.test" });
  const server = express().use("/api", accounts.router).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    await accounts.bootstrapAdministrator(fixtureEmail, fixturePassword);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://scribe.example.test" },
      body: JSON.stringify({ email: fixtureEmail, password: fixturePassword }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie")!, /Secure/i);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    accounts.close();
    await rm(directory, { recursive: true, force: true });
  }
});
