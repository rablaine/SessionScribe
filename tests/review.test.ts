import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDemo } from "../src/demo.js";
import { JobStore } from "../src/store.js";
import { createSessionFixture } from "./session-fixture.js";

async function fixture() {
  return createSessionFixture("dnd-review-test-");
}

test("retained audio serves MP3/Opus byte ranges and is removed only on session deletion", async () => {
  const f = await fixture();
  const fetch = f.request;
  try {
    for (const [name, mime] of [["recording.mp3", "audio/mpeg"], ["recording.opus", "audio/ogg"]] as const) {
      const job = await f.save({ ...createDemo(), originalName: name, demo: false, audioRetained: true });
      const bytes = Buffer.from("0123456789abcdefghijklmnop");
      await writeFile(f.store.audioPath(job.id), bytes);
      const url = `${f.base}/api/jobs/${job.id}/audio`;
      const response = await fetch(url, { headers: { Range: "bytes=2-5" } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), `bytes 2-5/${bytes.length}`);
      assert.match(response.headers.get("content-type")!, new RegExp(`^${mime}`));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "2345");
      const suffix = await fetch(url, { headers: { Range: "bytes=-4" } });
      assert.equal(suffix.status, 206);
      assert.equal(await suffix.text(), "mnop");
      const head = await fetch(url, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-length"), String(bytes.length));
      assert.equal(await (await fetch(url)).text(), bytes.toString());
      const invalidRange = await fetch(url, { headers: { Range: "bytes=999-1000" } });
      assert.equal(invalidRange.status, 416);
      assert.equal(invalidRange.headers.get("content-range"), `bytes */${bytes.length}`);
      assert.equal((await fetch(url, { headers: { Origin: "https://untrusted.example" } })).status, 403);
      assert.equal((await fetch(`${f.base}/api/jobs/${job.id}`, { method: "DELETE" })).status, 204);
      await assert.rejects(access(f.store.audioPath(job.id)), /ENOENT/);
    }
    const legacy = await f.save(createDemo());
    assert.equal((await fetch(`${f.base}/api/jobs/${legacy.id}/audio`)).status, 404);
    const missing = await f.save({ ...createDemo(), audioRetained: true });
    assert.equal((await fetch(`${f.base}/api/jobs/${missing.id}/audio`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/jobs/missing/audio`)).status, 404);
  } finally {
    await f.close();
  }
});

test("transcript edits are validated, durable, mark retained recaps stale, and appear in every export", async () => {
  const f = await fixture();
  const fetch = f.request;
  try {
    const job = await f.save({ ...createDemo(), demo: false });
    const url = `${f.base}/api/jobs/${job.id}/transcript`;
    const first = job.segments[0]!;
    const patch = (body: unknown) => fetch(url, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const noop = await patch({ segments: [{ id: first.id, text: first.text }] });
    assert.equal(noop.status, 200);
    assert.deepEqual((await noop.json()).recap, job.recap);
    for (const body of [
      { segments: [] },
      { segments: [{ id: "missing", text: "Changed" }] },
      { segments: [{ id: first.id, text: "  " }] },
      { segments: [{ id: first.id, text: "x".repeat(10001) }] },
      { segments: [{ id: first.id, text: "Changed", speaker: "intruder" }] },
      { segments: [{ id: first.id, text: "Changed", startMs: 999 }] },
      { segments: [{ id: first.id, text: "One" }, { id: first.id, text: "Two" }] },
    ]) assert.equal((await patch(body)).status, 400);
    f.runner.busyIds.add(job.id);
    assert.equal((await patch({ segments: [{ id: first.id, text: "Changed" }] })).status, 409);
    f.runner.busyIds.delete(job.id);
    await f.store.save({ ...job, status: "queued" });
    assert.equal((await patch({ segments: [{ id: first.id, text: "Changed" }] })).status, 409);
    await f.store.save(job);
    const oversized = await patch({ segments: [{ id: first.id, text: "x".repeat(70 * 1024) }] });
    assert.equal(oversized.status, 413);
    const text = "Corrected line with <tag> and *literal emphasis*.\nThe door is still closed.";
    const response = await patch({ segments: [{ id: first.id, text, speaker: "speaker-2" }] });
    assert.equal(response.status, 200);
    const edited = await response.json();
    assert.equal(edited.status, "transcript_ready");
    assert.deepEqual(edited.recap, job.recap);
    assert.equal(edited.recapStale, true);
    assert.equal(edited.segments[0].text, text);
    assert.equal(edited.segments[0].speaker, "speaker-2");
    assert.equal(edited.segments[0].startMs, first.startMs);
    assert.equal(edited.segments[0].endMs, first.endMs);
    assert.equal(edited.segments[0].id, first.id);
    assert.equal(edited.segments.length, job.segments.length);
    const reloaded = new JobStore(f.root);
    await reloaded.init();
    assert.equal(reloaded.get(job.id)!.segments[0]!.text, text);
    assert.equal(reloaded.get(job.id)!.recapStale, true);
    assert.deepEqual(reloaded.get(job.id)!.recap, job.recap);
    for (const format of ["txt", "srt", "json", "md"]) {
      const exported = await fetch(`${f.base}/api/jobs/${job.id}/export/${format}`);
      assert.equal(exported.status, 200);
      const content = await exported.text();
      assert.match(content, /Corrected line/);
      if (format === "md") {
        assert.match(exported.headers.get("content-type")!, /^text\/markdown/);
        assert.match(exported.headers.get("content-disposition")!, new RegExp(`transcript-${job.id}\\.md`));
        assert.match(content, /\[00:00:04 - 00:00:11\]/);
        assert.match(content, /&lt;tag&gt;/);
        assert.match(content, /\\\*literal emphasis\\\*/);
        assert(!content.includes("<tag>"));
      }
    }
    const recapExport = await fetch(`${f.base}/api/jobs/${job.id}/export/recap`);
    assert.equal(recapExport.status, 200);
    assert.match(await recapExport.text(), /OUT OF DATE/);
    const speakerThree = job.segments.filter(segment => segment.speaker === "speaker-3");
    assert.equal((await patch({ segments: speakerThree.map(segment => ({
      id: segment.id, text: segment.text, speaker: "speaker-2",
    })) })).status, 200);
    assert.equal((await patch({ segments: [{
      id: speakerThree[0]!.id, text: speakerThree[0]!.text, speaker: "speaker-3",
    }] })).status, 200);
    assert.equal((await fetch(`${f.base}/api/jobs/missing/transcript`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}",
    })).status, 404);
  } finally {
    await f.close();
  }
});

test("existing transcript-save flow deletes only specified entries, keeps audio and recap, and allows empty exports", async () => {
  const f = await fixture();
  const fetch = f.request;
  try {
    const job = await f.save({ ...createDemo(), demo: false, audioRetained: true });
    await writeFile(f.store.audioPath(job.id), "original recording");
    const url = `${f.base}/api/jobs/${job.id}/transcript`;
    const patch = (segments: unknown[]) => fetch(url, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ segments }),
    });
    const first = job.segments[0]!;
    for (const segments of [
      [{ id: first.id, delete: false }],
      [{ id: first.id, delete: true, text: "unexpected" }],
      [{ id: first.id, delete: true }, { id: first.id, text: "duplicate" }],
      [{ id: "missing", delete: true }],
    ]) assert.equal((await patch(segments)).status, 400);
    f.runner.busyIds.add(job.id);
    assert.equal((await patch([{ id: first.id, delete: true }])).status, 409);
    f.runner.busyIds.delete(job.id);
    const response = await patch([{ id: first.id, delete: true }]);
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.deepEqual(updated.segments, job.segments.slice(1));
    assert.deepEqual(updated.recap, job.recap);
    assert.equal(updated.recapStale, true);
    assert.equal(updated.audioRetained, true);
    await access(f.store.audioPath(job.id));
    const recap = await (await fetch(`${f.base}/api/jobs/${job.id}/export/recap`)).text();
    assert.match(recap, /OUT OF DATE/);
    assert.match(recap, /S00001 \(deleted entry\)/);
    const transcript = await (await fetch(`${f.base}/api/jobs/${job.id}/export/md`)).text();
    assert(!transcript.includes(first.text));
    const reloaded = new JobStore(f.root);
    await reloaded.init();
    assert.deepEqual(reloaded.get(job.id)!.segments, job.segments.slice(1));
    assert.equal(reloaded.get(job.id)!.recapStale, true);
    assert.equal((await patch(job.segments.slice(1).map(segment => ({ id: segment.id, delete: true })))).status, 200);
    assert.equal(f.store.get(job.id)!.segments.length, 0);
    assert.deepEqual(f.store.get(job.id)!.recap, job.recap);
    for (const format of ["json", "txt", "srt", "md", "recap"]) {
      assert.equal((await fetch(`${f.base}/api/jobs/${job.id}/export/${format}`)).status, 200);
    }
    assert.equal((await fetch(`${f.base}/api/jobs/${job.id}/recap`, { method: "POST" })).status, 409);
    assert.equal((await fetch(`${f.base}/api/jobs/${job.id}/audio`)).status, 200);
    const emptyReload = new JobStore(f.root);
    await emptyReload.init();
    assert.equal(emptyReload.get(job.id)!.segments.length, 0);
    assert.equal(emptyReload.get(job.id)!.status, "transcript_ready");

    const renamed = await f.save({ ...createDemo(), demo: false });
    const rename = (names: unknown) => fetch(`${f.base}/api/jobs/${renamed.id}/speakers`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(names),
    });
    const noChange = await (await rename(renamed.speakerNames)).json();
    assert.equal(noChange.recapStale, false);
    const nameChange = await (await rename({ "speaker-1": "New DM name" })).json();
    assert.equal(nameChange.recapStale, true);
    assert.deepEqual(nameChange.recap, renamed.recap);
  } finally {
    await f.close();
  }
});

test("legacy sessions discover surviving local audio but cannot restore already-deleted recordings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dnd-audio-migration-test-"));
  try {
    const store = new JobStore(root);
    const job = await store.save(createDemo());
    const { audioRetained: _audioRetained, ...legacy } = job;
    await writeFile(path.join(store.directory(job.id), "job.json"), JSON.stringify(legacy));
    await writeFile(store.audioPath(job.id), "retained audio");
    const reloaded = new JobStore(root);
    await reloaded.init();
    assert.equal(reloaded.get(job.id)!.audioRetained, true);
    assert.equal(JSON.parse(await readFile(path.join(store.directory(job.id), "job.json"), "utf8")).audioRetained, true);
    await rm(store.audioPath(job.id));
    const removed = new JobStore(root);
    await removed.init();
    assert.equal(removed.get(job.id)!.audioRetained, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
