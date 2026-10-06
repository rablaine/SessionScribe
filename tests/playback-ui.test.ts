import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Player {
  src: string;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}
interface Playback {
  load(player: Player, id: string, status: (text: string) => void): Promise<void>;
  clear(player: Player): void;
}
function fixture(request: (url: string, options: { signal: AbortSignal }) => Promise<unknown>) {
  const host: { SessionScribePlayback?: Playback; SessionScribeAuth: { request: typeof request } } = {
    SessionScribeAuth: { request },
  };
  runInNewContext(readFileSync(new URL("../public/playback.js", import.meta.url), "utf8"), {
    window: host, AbortController, Date, setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout,
  });
  const player: Player = { src: "", pause() {}, load() {}, removeAttribute() { this.src = ""; } };
  return { playback: host.SessionScribePlayback!, player };
}

test("both players wait for the indexed playback URL instead of loading unindexed audio", async () => {
  let calls = 0;
  const f = fixture(async url => {
    assert.equal(url, "/api/jobs/session/playback");
    return ++calls === 1 ? { status: "generating" } : { status: "ready", url: "/api/jobs/session/audio?indexed=1" };
  });
  const statuses: string[] = [];
  await f.playback.load(f.player, "session", text => statuses.push(text));
  assert.equal(calls, 2);
  assert.equal(f.player.src, "/api/jobs/session/audio?indexed=1");
  assert.match(statuses[0]!, /accurate seek index/);
});

test("switching sessions or closing a player cancels stale playback preparation", async () => {
  let complete: ((value: unknown) => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  const f = fixture(async (url, options) => {
    if (url.includes("/old/")) {
      oldSignal = options.signal;
      return new Promise(resolve => { complete = resolve; });
    }
    return { status: "ready", url: "/api/jobs/new/audio" };
  });
  const old = f.playback.load(f.player, "old", () => assert.fail("A stale load cannot update the UI."));
  await f.playback.load(f.player, "new", () => {});
  assert.equal(oldSignal!.aborted, true);
  complete!({ status: "ready", url: "/api/jobs/old/audio?indexed=1" });
  await assert.rejects(old, { name: "AbortError" });
  assert.equal(f.player.src, "/api/jobs/new/audio");

  const closing = f.playback.load(f.player, "old", () => {});
  f.playback.clear(f.player);
  complete!({ status: "ready", url: "/api/jobs/old/audio" });
  await assert.rejects(closing, { name: "AbortError" });
});

test("playback never hides preparation failures or accepts an unexpected audio URL", async () => {
  for (const request of [
    async () => { throw new Error("Preparation failed."); },
    async () => ({ status: "ready", url: "https://outside.example/audio" }),
    async () => ({ status: "unrecognized" }),
  ]) {
    const f = fixture(request);
    await assert.rejects(f.playback.load(f.player, "session", () => {}), /failed|invalid/);
    assert.equal(f.player.src, "");
  }
});
