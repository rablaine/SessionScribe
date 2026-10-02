import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Accounts } from "../src/accounts.js";
import { config } from "../src/config.js";
import { clipFilename, inspectRecording, runTool } from "../src/audio.js";
import { createDemo } from "../src/demo.js";
import { createSessionFixture } from "./session-fixture.js";

test("clip ranges validate, persist, stay session-bound, and cascade on session deletion", async () => {
  const f = await createSessionFixture("scribe-clips-");
  try {
    const job = await f.save({ ...createDemo(), demo: false, audioRetained: true, durationMs: 6000 });
    await writeFile(f.store.audioPath(job.id), "fixture");
    const base = `${f.base}/api/jobs/${job.id}/clips`;
    const save = (body: unknown, url = base, method = "POST") => f.request(url, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.deepEqual(await (await f.request(base)).json(), []);
    for (const body of [
      { startMs: -1, endMs: 2000 }, { startMs: 2000, endMs: 2000 },
      { startMs: 3000, endMs: 2000 }, { startMs: 0, endMs: 6001 },
      { startMs: 1.5, endMs: 2000 }, { startMs: 0, endMs: 2000, extra: true },
      { startMs: 0, endMs: 2000, name: "a".repeat(121) },
      { startMs: 0, endMs: 2000, name: 7 },
      { startMs: 0, endMs: 2000, name: "bad\u0000name" },
      { startMs: 0, endMs: 2000, name: "\ud800" },
    ]) assert.equal((await save(body)).status, 400);
    assert.equal((await fetch(base, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: f.credentials.cookie },
      body: JSON.stringify({ startMs: 0, endMs: 2000 }),
    })).status, 403);
    const response = await save({ startMs: 0, endMs: 6000, name: "  The dragon's bargain  " });
    assert.equal(response.status, 201);
    const clip = await response.json();
    assert.equal(clip.startMs, 0);
    assert.equal(clip.endMs, 6000);
    assert.equal(clip.jobId, job.id);
    assert.equal(clip.name, "The dragon's bargain");
    const reopened = new Accounts({ databasePath: path.join(f.root, "accounts.sqlite") });
    try { assert.deepEqual(reopened.listClips(job.id), [clip]); } finally { reopened.close(); }
    const edited = await save({ startMs: 500, endMs: 1500 }, `${base}/${clip.id}`, "PATCH");
    assert.equal(edited.status, 200);
    const editedClip = await edited.json();
    assert.equal(editedClip.id, clip.id);
    assert.equal(editedClip.name, clip.name, "Range-only edits preserve the name.");
    const renamed = await save({ startMs: 500, endMs: 1500, name: '<b>Critical hit</b> \u2694' }, `${base}/${clip.id}`, "PATCH");
    assert.equal(renamed.status, 200);
    const renamedClip = await renamed.json();
    assert.equal(renamedClip.name, '<b>Critical hit</b> \u2694');
    assert.equal(renamedClip.createdAt, clip.createdAt);
    assert.deepEqual(await (await f.request(base)).json(), [renamedClip]);
    const restart = new Accounts({ databasePath: path.join(f.root, "accounts.sqlite") });
    try { assert.equal(restart.clip(job.id, clip.id)?.name, renamedClip.name); } finally { restart.close(); }
    const cleared = await save({ startMs: 500, endMs: 1500, name: "   " }, `${base}/${clip.id}`, "PATCH");
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).name, "");
    const other = await f.save({ ...createDemo(), audioRetained: true });
    assert.equal((await f.request(`${f.base}/api/jobs/${other.id}/clips/${clip.id}/export`)).status, 404);
    assert.equal((await save({ startMs: 0, endMs: 1000 }, `${base}/missing`, "PATCH")).status, 404);
    const unowned = await f.store.save({ ...createDemo(), audioRetained: true });
    assert.equal((await f.request(`${f.base}/api/jobs/${unowned.id}/clips`)).status, 404);
    assert.equal((await save({ startMs: 0, endMs: 1000 }, `${f.base}/api/jobs/${unowned.id}/clips`)).status, 404);
    await f.store.save({ ...job, audioRetained: false });
    assert.equal((await save({ startMs: 0, endMs: 1000 })).status, 409);
    assert.equal((await f.request(`${base}/${clip.id}/export`)).status, 410);
    assert.equal((await f.request(base)).status, 200);
    assert.equal((await f.request(`${f.base}/api/jobs/${job.id}`, { method: "DELETE" })).status, 204);
    assert.deepEqual(f.accounts.listClips(job.id), []);
  } finally { await f.close(); }
});

test("MP3 and Opus clip exports contain only the selected interval of original audio", async () => {
  const f = await createSessionFixture("scribe-clip-media-");
  try {
    for (const extension of ["mp3", "opus"]) {
      const job = await f.save({ ...createDemo(), demo: false, originalName: `test.${extension}`,
        audioRetained: true, durationMs: 6000 });
      await runTool(config.ffmpeg, [
        "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
        "aevalsrc=0.2*sin(2*PI*if(lt(t\\,3)\\,440\\,880)*t):s=48000:d=6",
        "-codec:a", extension === "mp3" ? "libmp3lame" : "libopus",
        "-f", extension === "mp3" ? "mp3" : "ogg", f.store.audioPath(job.id),
      ], 60000);
      const base = `${f.base}/api/jobs/${job.id}/clips`;
      const saved = await f.request(base, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startMs: 3500, endMs: 5500, name: extension === "mp3" ? "Dragon / bargain" : "Dragon \u2694" }) });
      assert.equal(saved.status, 201);
      const clip = await saved.json();
      const exported = await f.request(`${base}/${clip.id}/export`);
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get("content-type")!, /^audio\/mpeg/);
      assert.match(exported.headers.get("content-disposition")!, /\.mp3/);
      if (extension === "mp3") assert.match(exported.headers.get("content-disposition")!, /filename="Dragon - bargain\.mp3"/);
      else assert.match(exported.headers.get("content-disposition")!, /filename\*=UTF-8''Dragon%20%E2%9A%94\.mp3/);
      assert.equal(exported.headers.get("cache-control"), "no-store");
      const file = path.join(f.root, `export-${extension}.mp3`);
      await writeFile(file, Buffer.from(await exported.arrayBuffer()));
      const duration = await inspectRecording(config.ffprobe, file, "clip.mp3");
      assert(Math.abs(duration - 2000) < 100, `Expected 2 seconds; got ${duration}ms`);
      const pcm = path.join(f.root, `decoded-${extension}.pcm`);
      await runTool(config.ffmpeg, ["-nostdin", "-v", "error", "-y", "-i", file,
        "-ac", "1", "-ar", "16000", "-f", "s16le", pcm], 60000);
      const samples = await readFile(pcm);
      let crossings = 0;
      assert(samples.length >= 48000, "Decoded clip must contain at least 1.5 seconds.");
      for (let i = 16000; i < 48000; i += 2) {
        if (samples.readInt16LE(i - 2) <= 0 && samples.readInt16LE(i) > 0) crossings++;
      }
      const frequency = crossings;
      assert(Math.abs(frequency - 880) < 20, `Expected selected 880Hz section, got ${frequency}`);
    }
  } finally { await f.close(); }
});

test("clip download names are portable, bounded, and preserve valid Unicode", () => {
  assert.equal(clipFilename("The dragon's bargain", "id"), "The dragon's bargain.mp3");
  assert.equal(clipFilename(' ..a/b\\c:d*e?f"g<h>i|j.. ', "id"), "a-b-c-d-e-f-g-h-i-j.mp3");
  assert.equal(clipFilename("CON.mp3", "id"), "clip-CON.mp3");
  assert.equal(clipFilename("COM\u00b2", "id"), "clip-COM\u00b2.mp3");
  assert.equal(clipFilename("NUL.backup", "id"), "clip-NUL.backup.mp3");
  assert.equal(clipFilename("Critical hit.MP3", "id"), "Critical hit.mp3");
  assert.equal(clipFilename("...", "id"), "clip-id.mp3");
  assert.equal(clipFilename("", "id"), "clip-id.mp3");
  assert.equal(clipFilename("Dragon \u2694", "id"), "Dragon \u2694.mp3");
  const long = clipFilename("\u9f8d".repeat(120), "id");
  assert(Buffer.byteLength(long, "utf8") <= 184);
  assert(!long.includes("\ufffd"), "Truncation must not break a Unicode character.");
});

test("version-two SQLite installations preserve existing unnamed clips when adding names", async () => {
  const f = await createSessionFixture("scribe-clip-name-migration-");
  try {
    const job = await f.save({ ...createDemo(), audioRetained: true });
    const original = f.accounts.saveClip(job.id, 1000, 2000);
    const db = new DatabaseSync(path.join(f.root, "accounts.sqlite"));
    db.exec("ALTER TABLE audio_clips DROP COLUMN name; PRAGMA user_version=2;");
    db.close();
    const migrated = new Accounts({ databasePath: path.join(f.root, "accounts.sqlite") });
    try {
      assert(migrated.isActiveUser(f.user.id));
      assert.deepEqual(migrated.listClips(job.id), [original]);
      const renamed = migrated.saveClip(job.id, 1000, 2000, original.id, "Old clip, new name");
      assert.equal(renamed.name, "Old clip, new name");
      assert.equal(renamed.createdAt, original.createdAt);
    } finally { migrated.close(); }
    const current = new DatabaseSync(path.join(f.root, "accounts.sqlite"));
    assert.equal(current.prepare("PRAGMA user_version").get()?.user_version, 4);
    current.close();
  } finally { await f.close(); }
});

test("version-one SQLite installations migrate clip storage without losing accounts", async () => {
  const f = await createSessionFixture("scribe-clip-migration-");
  try {
    const db = new DatabaseSync(path.join(f.root, "accounts.sqlite"));
    db.exec("DROP TABLE audio_clips; PRAGMA user_version=1;");
    db.close();
    const migrated = new Accounts({ databasePath: path.join(f.root, "accounts.sqlite") });
    try {
      assert(migrated.isActiveUser(f.user.id));
      assert.deepEqual(migrated.listClips("missing"), []);
    } finally { migrated.close(); }
  } finally { await f.close(); }
});
