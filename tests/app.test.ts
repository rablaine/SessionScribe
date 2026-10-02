import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { request } from "node:http";
import { JobStore } from "../src/store.js";
import { config } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { createSessionFixture } from "./session-fixture.js";

test("browser API: durable demo, safe exports, rename, validation, deletion, origin guard", async () => {
  const f = await createSessionFixture("dnd-scribe-test-");
  const { root: directory, store, base } = f;
  const fetch = f.request;
  try {
    assert.equal((await fetch(`${base}/api/config`)).status, 200);
    assert.equal((await fetch(`${base}/api/jobs`, { headers: { Origin: "https://untrusted.example" } })).status, 403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/jobs`, { headers: { Host: "public.example" } }, response => {
        response.resume();
        resolve(response.statusCode);
      });

      req.on("error", reject);
      req.end();
    });
    assert.equal(hostStatus, 403);
    const created = await fetch(`${base}/api/demo`, { method: "POST" });
    assert.equal(created.status, 201);
    const job = await created.json();
    assert.equal(job.demo, true);
    assert.equal(job.segments.length, 8);
    assert.equal(job.status, "completed");
    assert.equal((await fetch(`${base}/api/jobs/${job.id}/export/txt`)).status, 200);
    const srt = await (await fetch(`${base}/api/jobs/${job.id}/export/srt`)).text();
    assert.match(srt, /00:00:04,000 --> 00:00:11,000/);
    const recap = await (await fetch(`${base}/api/jobs/${job.id}/export/recap`)).text();
    assert.match(recap, /DEMO/);
    assert.match(recap, /S00008 @ 00:01:54/);
    const reloaded = new JobStore(directory);
    await reloaded.init();
    assert.equal(reloaded.get(job.id)!.segments.length, 8);
    assert.match(await readFile(path.join(directory, job.id, "job.json"), "utf8"), /fictional-demo/);
    const invalid = await fetch(`${base}/api/jobs/${job.id}/speakers`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intruder: "Name" }),
    });
    assert.equal(invalid.status, 400);
    const changed = await fetch(`${base}/api/jobs/${job.id}/speakers`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "speaker-1": "Dungeon Master" }),
    });
    assert.equal(changed.status, 200);
    assert.match(await (await fetch(`${base}/api/jobs/${job.id}/export/txt`)).text(), /Dungeon Master:/);
    assert.equal((await fetch(`${base}/api/jobs/${job.id}/recap`, { method: "POST" })).status, 400);
    assert.equal((await fetch(`${base}/api/jobs/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/jobs/${job.id}/export/invalid`)).status, 400);
    assert.equal((await fetch(`${base}/api/jobs/${job.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/api/jobs/${job.id}`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/jobs`)).json(), []);
  } finally {
    await f.close();
  }
});

test("upload API accepts MP3 and Opus extensions with generic MIME types, rejects other names", async () => {
  const originalConfig = { ...config };
  Object.assign(config, {
    speechEndpoint: "https://fixture.cognitiveservices.azure.com",
    storageAccountUrl: "https://fixture.blob.core.windows.net", authMode: "azure-cli",
  });

  test("laughter API queues retained recordings without changing transcript state", async () => {
    const f = await createSessionFixture("dnd-laughter-api-test-");
    const queued: string[] = [];
    f.runner.enqueueLaughter = id => { queued.push(id); };
    try {
      const job = await f.save({ ...createDemo(), demo: false, audioRetained: true, durationMs: 10_000,
        laughter: { status: "pending", events: [] } });
      const response = await f.request(`${f.base}/api/jobs/${job.id}/laughter`, { method: "POST" });
      assert.equal(response.status, 202);
      const updated = await response.json();
      assert.equal(updated.status, "completed");
      assert.equal(updated.laughter.status, "queued");
      assert.deepEqual(queued, [job.id]);
      assert.equal((await f.request(`${f.base}/api/jobs/${job.id}/laughter`, { method: "POST" })).status, 202);
      const demo = await f.save(createDemo());
      assert.equal((await f.request(`${f.base}/api/jobs/${demo.id}/laughter`, { method: "POST" })).status, 400);
    } finally {
      await f.close();
    }
  });
  const f = await createSessionFixture("dnd-upload-formats-test-");
  const { store, runner, base } = f;
  const fetch = f.request;
  const queued: string[] = [];
  runner.enqueue = id => { queued.push(id); };
  try {
    for (const name of ["party.mp3", "party.opus", "party.OPUS", "party.ogg", "party.OGG", "party.wav", "party.opus.exe"]) {
      const form = new FormData();
      form.set("audio", new Blob(["fixture bytes; the worker validates actual codecs"], { type: "application/octet-stream" }), name);
      form.set("title", "Format test");
      form.set("consent", "true");
      const response = await fetch(`${base}/api/jobs`, { method: "POST", body: form });
      if (name.endsWith(".wav") || name.endsWith(".exe")) {
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /Only MP3 and Ogg Opus/);
      } else {
        assert.equal(response.status, 202);
        const job = await response.json();
        assert.equal(job.originalName, name);
        assert(queued.includes(job.id));
        assert.match(await readFile(store.audioPath(job.id), "utf8"), /fixture bytes/);
      }
    }
    assert.equal(queued.length, 5);
  } finally {
    Object.assign(config, originalConfig);
    await f.close();
  }
});
