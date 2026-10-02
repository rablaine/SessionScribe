import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { runTool } from "../src/audio.js";
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

async function makeRecording(directory: string, name: string, codec: "libmp3lame" | "libopus") {
  const file = path.join(directory, name);
  await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:a", codec, file], 60_000);
  return readFile(file);
}

async function chunkedUpload(f: Awaited<ReturnType<typeof createSessionFixture>>, name: string, bytes: Buffer, title = "Upload test") {
  const start = await f.request(`${f.base}/api/uploads`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, consent: true, filename: name, size: bytes.length }),
  });
  if (start.status !== 201) return start;
  const { id, chunkBytes } = await start.json() as { id: string; chunkBytes: number };
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const chunk = bytes.subarray(offset, offset + chunkBytes);
    const sent = await f.request(`${f.base}/api/uploads/${id}/chunk?offset=${offset}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: chunk,
    });
    assert.equal(sent.status, 200);
  }
  return f.request(`${f.base}/api/uploads/${id}/complete`, { method: "POST" });
}

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
    const demo = await f.save(createDemo());
    assert.equal((await f.request(`${f.base}/api/jobs/${demo.id}/laughter`, { method: "POST" })).status, 400);
  } finally {
    await f.close();
  }
});

test("chunked uploads: resumable, owner-bound, validated by ffprobe, and stamped with a 30-day expiry", async () => {
  const originalConfig = { ...config };
  Object.assign(config, {
    speechEndpoint: "https://fixture.cognitiveservices.azure.com",
    storageAccountUrl: "https://fixture.blob.core.windows.net", authMode: "azure-cli",
  });
  const f = await createSessionFixture("dnd-chunked-upload-test-");
  const queued: string[] = [];
  f.runner.enqueue = id => { queued.push(id); };
  const scratch = await mkdtemp(path.join(os.tmpdir(), "dnd-upload-audio-"));
  try {
    const mp3 = await makeRecording(scratch, "party.mp3", "libmp3lame");
    const opus = await makeRecording(scratch, "party.opus", "libopus");
    for (const [name, bytes] of [["party.mp3", mp3], ["party.OPUS", opus], ["party.ogg", opus]] as const) {
      const response = await chunkedUpload(f, name, bytes);
      assert.equal(response.status, 202, name);
      const job = await response.json();
      assert.equal(job.originalName, name);
      assert.equal(job.recordingState, "available");
      assert(job.durationMs > 2500 && job.durationMs < 3500);
      assert.equal(Date.parse(job.recordingExpiresAt) - Date.parse(job.recordingUploadedAt), 30 * 86_400_000);
      assert.deepEqual(await readFile(f.store.audioPath(job.id)), bytes);
      assert(queued.includes(job.id));
    }
    for (const name of ["party.wav", "party.opus.exe"]) {
      const response = await chunkedUpload(f, name, mp3);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Only MP3 and Ogg Opus/);
    }
    // Bytes that pass the extension check but are not real audio are rejected and deleted.
    const fake = await chunkedUpload(f, "fake.mp3", Buffer.from("not really audio"));
    assert.equal(fake.status, 400);
    assert.deepEqual(await readdir(path.join(f.root, "uploads")), []);

    // Resume: a wrong offset reports the confirmed position; one active upload per user.
    const start = await f.request(`${f.base}/api/uploads`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Resume", consent: true, filename: "resume.mp3", size: mp3.length }),
    });
    const { id } = await start.json();
    const second = await f.request(`${f.base}/api/uploads`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Second", consent: true, filename: "second.mp3", size: 10 }),
    });
    assert.equal(second.status, 409);
    const half = Math.floor(mp3.length / 2);
    assert.equal((await f.request(`${f.base}/api/uploads/${id}/chunk?offset=0`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: mp3.subarray(0, half),
    })).status, 200);
    const mismatch = await f.request(`${f.base}/api/uploads/${id}/chunk?offset=0`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: mp3.subarray(0, 10),
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).received, half);
    assert.equal((await f.request(`${f.base}/api/uploads/${id}/complete`, { method: "POST" })).status, 409);
    assert.equal((await (await f.request(`${f.base}/api/uploads/${id}`)).json()).received, half);
    // Other users and anonymous callers cannot see or write this upload.
    assert.equal((await fetch(`${f.base}/api/uploads/${id}`)).status, 401);
    assert.equal((await f.request(`${f.base}/api/uploads/${id}`, { method: "DELETE" })).status, 204);
    assert.equal((await f.request(`${f.base}/api/uploads/${id}`)).status, 404);
  } finally {
    Object.assign(config, originalConfig);
    await rm(scratch, { recursive: true, force: true });
    await f.close();
  }
});

test("per-user daily quotas stop repeated billable recaps and laughter runs", async () => {
  const originalConfig = { ...config, quotas: { ...config.quotas } };
  Object.assign(config, {
    openaiEndpoint: "https://fixture.openai.azure.com", openaiDeployment: "fixture", authMode: "azure-cli",
    quotas: { ...config.quotas, recaps: 2, laughter: 1 },
  });
  const f = await createSessionFixture("dnd-quota-test-");
  f.runner.enqueue = () => {};
  f.runner.enqueueLaughter = () => {};
  try {
    const job = await f.save({ ...createDemo(), demo: false, audioRetained: true, durationMs: 10_000 });
    assert.equal((await f.request(`${f.base}/api/jobs/${job.id}/recap`, { method: "POST" })).status, 202);
    assert.equal((await f.request(`${f.base}/api/jobs/${job.id}/recap`, { method: "POST" })).status, 202);
    const limited = await f.request(`${f.base}/api/jobs/${job.id}/recap`, { method: "POST" });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /Daily recap limit/);
    assert.equal((await f.request(`${f.base}/api/jobs/${job.id}/laughter`, { method: "POST" })).status, 202);
    assert.equal((await f.request(`${f.base}/api/jobs/${job.id}/laughter`, { method: "POST" })).status, 429);
  } finally {
    Object.assign(config, originalConfig);
    await f.close();
  }
});