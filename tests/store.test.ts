import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDemo } from "../src/demo.js";
import { JobStore } from "../src/store.js";

function filesystemError(code: string) {
  return Object.assign(new Error(`Fixture rename ${code}`), { code });
}

async function directory() {
  const root = path.resolve("data", `store-test-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

test("atomic job persistence retries only transient Windows rename locks before updating map", async () => {
  const root = await directory();
  const waits: number[] = [];
  const locks = ["EPERM", "EACCES", "EBUSY"];
  let attempts = 0;
  let stored: ReturnType<JobStore["get"]>;
  const store = new JobStore(root, {
    platform: "win32",
    delay: async milliseconds => { waits.push(milliseconds); },
    rename: async (source, target) => {
      assert.equal(store.get(job.id), stored, "map must not update before rename succeeds");
      const code = locks[attempts++];
      if (code) {
        assert.equal(await readFile(target, "utf8"), original);
        throw filesystemError(code);
      }
      await rename(source, target);
    },
  });
  const job = createDemo();
  let original = "";
  try {
    await new JobStore(root).save(job);
    await store.init();
    stored = store.get(job.id);
    original = await readFile(path.join(store.directory(job.id), "job.json"), "utf8");
    const saved = await store.save({ ...job, title: "Successfully retried" });
    assert.equal(attempts, 4);
    assert.deepEqual(waits, [50, 100, 200]);
    assert.equal(store.get(job.id), saved);
    assert.equal(JSON.parse(await readFile(path.join(store.directory(job.id), "job.json"), "utf8")).title, saved.title);
    assert.deepEqual(await readdir(store.directory(job.id)), ["job.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded rename failure rejects, preserves durable file/map, cleans temp, and permits later recovery", async () => {
  const root = await directory();
  const waits: number[] = [];
  let attempts = 0;
  let locked = false;
  const failure = filesystemError("EPERM");
  const store = new JobStore(root, {
    platform: "win32",
    delay: async milliseconds => { waits.push(milliseconds); },
    rename: async (source, target) => {
      if (locked) { attempts++; throw failure; }
      await rename(source, target);
    },
  });
  try {
    const job = await store.save(createDemo());
    const target = path.join(store.directory(job.id), "job.json");
    const original = await readFile(target, "utf8");
    locked = true;
    await assert.rejects(store.save({ ...job, title: "Must not persist" }), error => error === failure);
    assert.equal(attempts, 7);
    assert.deepEqual(waits, [50, 100, 200, 400, 800, 1600]);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(store.get(job.id), job);
    assert.deepEqual(await readdir(store.directory(job.id)), ["job.json"]);
    locked = false;
    await store.save({ ...job, title: "Recovered after unlock" });
    assert.equal(store.get(job.id)?.title, "Recovered after unlock");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Windows locks and unrelated errors are never retried", async () => {
  for (const [platform, code] of [["linux", "EPERM"], ["win32", "EIO"], ["win32", "ENOSPC"], ["win32", "ENOENT"]] as const) {
    const root = await directory();
    let attempts = 0;
    const failure = filesystemError(code);
    const store = new JobStore(root, {
      platform, rename: async () => { attempts++; throw failure; },
      delay: async () => { assert.fail("Unexpected retry"); },
    });
    try {
      const job = createDemo();
      await assert.rejects(store.save(job), error => error === failure);
      assert.equal(attempts, 1);
      assert.equal(store.get(job.id), undefined);
      assert.deepEqual(await readdir(store.directory(job.id)), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("same-job saves are serialized with unique atomic temporary names", async () => {
  const root = await directory();
  let release!: () => void;
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const holdFirst = new Promise<void>(resolve => { release = resolve; });
  const sources: string[] = [];
  const store = new JobStore(root, {
    rename: async (source, target) => {
      sources.push(source);
      if (sources.length === 1) { entered(); await holdFirst; }
      await rename(source, target);
    },
  });
  try {
    const job = createDemo();
    const first = store.save({ ...job, title: "First" });
    await firstEntered;
    const second = store.save({ ...job, title: "Second" });
    assert.equal(sources.length, 1);
    release();
    const [firstSaved, secondSaved] = await Promise.all([first, second]);
    assert.equal(firstSaved.title, "First");
    assert.equal(secondSaved.title, "Second");
    assert.equal(store.get(job.id), secondSaved);
    assert.equal(sources.length, 2);
    assert.notEqual(sources[0], sources[1]);
    assert.equal(JSON.parse(await readFile(path.join(store.directory(job.id), "job.json"), "utf8")).title, "Second");
    assert.deepEqual(await readdir(store.directory(job.id)), ["job.json"]);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});
