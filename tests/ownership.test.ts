import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Accounts } from "../src/accounts.js";
import { createDemo } from "../src/demo.js";
import { createSessionFixture } from "./session-fixture.js";

const userPassword = "Only a test password 123!";

test("active accounts own every session route; even administrators cannot access another user's recording", async () => {
  const f = await createSessionFixture("dnd-ownership-test-");
  try {
    const registration = await fetch(`${f.base}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "player@example.test", password: userPassword }),
    });
    assert(registration.ok);
    const users = await (await f.request(`${f.base}/api/admin/users`)).json();
    const player = users.users.find((user: { email: string }) => user.email === "player@example.test");
    assert(player);
    const approved = await f.request(`${f.base}/api/admin/users/${player.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active", confirmedIdentity: true }),
    });
    assert.equal(approved.status, 200);
    const login = await fetch(`${f.base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: player.email, password: userPassword }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert(cookie);
    const playerRequest = (url: string, options: RequestInit = {}) => {
      const headers = new Headers(options.headers);
      headers.set("Cookie", cookie);
      headers.set("X-CSRF-Token", loginBody.csrfToken);
      return fetch(url, { ...options, headers });
    };
    const created = await playerRequest(`${f.base}/api/demo`, { method: "POST" });
    assert.equal(created.status, 201);
    const job = await created.json();
    await f.store.save({ ...f.store.get(job.id)!, audioRetained: true });
    await writeFile(f.store.audioPath(job.id), "private recording");
    const own = await f.save(createDemo());
    const unowned = await f.store.save(createDemo());
    const playerList = await (await playerRequest(`${f.base}/api/jobs`)).json();
    assert.deepEqual(playerList.map((value: { id: string }) => value.id), [job.id]);
    const adminList = await (await f.request(`${f.base}/api/jobs`)).json();
    assert.deepEqual(adminList.map((value: { id: string }) => value.id), [own.id]);
    for (const [method, suffix] of [
      ["GET", ""], ["HEAD", "/audio"], ["GET", "/audio"],
      ["GET", "/export/json"], ["GET", "/export/txt"], ["GET", "/export/md"],
      ["GET", "/export/srt"], ["GET", "/export/recap"],
      ["PATCH", "/speakers"], ["PATCH", "/transcript"],
      ["POST", "/recap"], ["DELETE", ""],
      ["GET", "/clips"], ["POST", "/clips"], ["PATCH", "/clips/missing"], ["GET", "/clips/missing/export"],
      ["GET", "/waveform?startMs=0&endMs=1000"],
    ]) {
      const options: RequestInit = { method };
      if (method === "PATCH") {
        options.headers = { "Content-Type": "application/json" };
        options.body = "{}";
      }
      const denied = await f.request(`${f.base}/api/jobs/${job.id}${suffix}`, options);
      assert.equal(denied.status, 404, `${method} ${suffix}`);
      if (method !== "HEAD") assert.deepEqual(await denied.json(), { error: "Session not found." });
    }
    assert.equal((await playerRequest(`${f.base}/api/jobs/${own.id}`)).status, 404);
    assert.equal((await f.request(`${f.base}/api/jobs/${unowned.id}`)).status, 404);
    assert.equal((await playerRequest(`${f.base}/api/jobs/${job.id}/audio`)).status, 200);
    const diskAccounts = new Accounts({ databasePath: path.join(f.root, "accounts.sqlite") });
    try {
      assert(diskAccounts.ownsJob(player.id, job.id));
      assert(!diskAccounts.ownsJob(f.user.id, job.id));
    } finally { diskAccounts.close(); }
    const deleted = await playerRequest(`${f.base}/api/jobs/${job.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert(!f.accounts.ownsJob(player.id, job.id));
  } finally { await f.close(); }
});

test("anonymous/pending requests and missing CSRF cannot read sessions or create upload directories", async () => {
  const f = await createSessionFixture("dnd-account-gates-test-");
  try {
    for (const url of ["/api/config", "/api/jobs", "/api/jobs/missing/audio", "/api/jobs/missing/export/json"]) {
      assert.equal((await fetch(`${f.base}${url}`)).status, 401);
    }
    const before = await readdir(f.root);
    assert.equal((await fetch(`${f.base}/api/uploads`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Anonymous", consent: true, filename: "recording.mp3", size: 10 }),
    })).status, 401);
    assert.equal((await fetch(`${f.base}/api/demo`, { method: "POST" })).status, 401);
    assert.deepEqual(await readdir(f.root), before);
    assert.equal((await fetch(`${f.base}/api/demo`, {
      method: "POST", headers: { Cookie: f.credentials.cookie },
    })).status, 403);
    const signup = await fetch(`${f.base}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pending@example.test", password: userPassword }),
    });
    assert(signup.ok);
    const login = await fetch(`${f.base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pending@example.test", password: userPassword }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    for (const [method, endpoint] of [["GET", "/api/jobs"], ["GET", "/api/config"],
      ["POST", "/api/demo"], ["POST", "/api/jobs"], ["GET", "/api/jobs/missing/audio"]]) {
      assert.equal((await fetch(`${f.base}${endpoint}`, {
        method, headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
      })).status, 403);
    }
    assert.equal(f.store.list().length, 0);
  } finally { await f.close(); }
});
