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
  load(player: Player, id: string, status: (text: string) => void, repair?: boolean): Promise<{ url: string } | null>;
  clear(player: Player): void;
}
function fixture(request: (url: string, options: { signal: AbortSignal; method: string }) => Promise<unknown>, confirmRepair = true) {
  const events: CustomEvent[] = [];
  const host: { SessionScribePlayback?: Playback; SessionScribeAuth: { request: typeof request };
    dispatchEvent(event: CustomEvent): void } = {
    SessionScribeAuth: { request }, dispatchEvent: event => { events.push(event); },
  };
  runInNewContext(readFileSync(new URL("../public/playback.js", import.meta.url), "utf8"), {
    window: host, AbortController, Date, CustomEvent, confirm: () => confirmRepair,
    setTimeout: (fn: () => void) => setTimeout(fn, 0), clearTimeout,
  });
  const player: Player = { src: "", pause() {}, load() {}, removeAttribute() { this.src = ""; } };
  return { playback: host.SessionScribePlayback!, player, events };
}

test("ordinary playback uses GET and loads the original immediately, without repair", async () => {
  const f = fixture(async (_url, options) => {
    assert.equal(options.method, "GET");
    return { status: "ready", url: "/api/jobs/session/audio" };
  });
  await f.playback.load(f.player, "session", () => assert.fail("Original playback needs no preparation."));
  assert.equal(f.player.src, "/api/jobs/session/audio");
  assert.equal(f.events.length, 0);
});

test("repair requires confirmation, POSTs once, then polls GET and notifies both players", async () => {
  let calls = 0;
  const f = fixture(async (url, options) => {
    assert.equal(url, "/api/jobs/session/playback");
    assert.equal(options.method, calls === 0 ? "POST" : "GET");
    return ++calls === 1 ? { status: "generating" } : { status: "ready", url: "/api/jobs/session/audio?playback=2" };
  });
  const statuses: string[] = [];
  await f.playback.load(f.player, "session", text => statuses.push(text), true);
  assert.equal(calls, 2);
  assert.equal(f.player.src, "/api/jobs/session/audio?playback=2");
  assert.match(statuses[0]!, /accurate playback/);
  assert.equal(f.events[0]!.type, "scribe-playback-repaired");
  assert.equal(f.events[0]!.detail.jobId, "session");
  assert.equal(f.events[0]!.detail.player, f.player);
});

test("declining repair leaves current playback unchanged and sends no request", async () => {
  const f = fixture(async () => assert.fail("Cancelled repair must not hit the server."), false);
  f.player.src = "/api/jobs/session/audio";
  assert.equal(await f.playback.load(f.player, "session", () => assert.fail(), true), null);
  assert.equal(f.player.src, "/api/jobs/session/audio");
  assert.equal(f.events.length, 0);
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
  complete!({ status: "ready", url: "/api/jobs/old/audio?playback=2" });
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
    async () => ({ status: "ready", url: "/api/jobs/session/audio?indexed=1" }),
    async () => ({ status: "unrecognized" }),
  ]) {
    const f = fixture(request);
    await assert.rejects(f.playback.load(f.player, "session", () => {}), /failed|invalid/);
    assert.equal(f.player.src, "");
  }
});
