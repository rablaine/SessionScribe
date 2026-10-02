import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Range = { startMs: number; endMs: number };
interface Timeline {
  viewForRange(start: number, end: number, duration: number): Range;
  timeAt(fraction: number, view: Range): number;
  zoomView(view: Range, fraction: number, factor: number, duration: number): Range;
  panView(view: Range, fraction: number, duration: number): Range;
  rulerTicks(view: Range, width: number): { timeMs: number; fraction: number; label: string }[];
  moveBoundary(edge: string, value: number, range: Range, duration: number): Range;
  keyboardTime(key: string, value: number, min: number, max: number, shift?: boolean): number | null;
}
const host: { SessionScribeClipTimeline?: Timeline } = {};
runInNewContext(readFileSync(new URL("../public/clip-timeline.js", import.meta.url), "utf8"), { window: host });
const timeline = host.SessionScribeClipTimeline!;

test("panning keeps the zoom span fixed, does not mutate the original view, and clamps to recording edges", () => {
  const view = { startMs: 20000, endMs: 60000 };
  const later = timeline.panView(view, 0.25, 90000);
  assert.equal(later.startMs, 30000);
  assert.equal(later.endMs, 70000);
  assert.equal(timeline.panView(view, -0.25, 90000).startMs, 10000);
  const first = timeline.panView(view, -100, 90000);
  const last = timeline.panView(view, 100, 90000);
  assert.equal(first.startMs, 0);
  assert.equal(first.endMs, 40000);
  assert.equal(last.startMs, 50000);
  assert.equal(last.endMs, 90000);
  assert.equal(view.startMs, 20000);
  assert.equal(view.endMs, 60000);
  assert.equal(timeline.panView({ startMs: 0, endMs: 90000 }, 100, 90000).startMs, 0);
});

test("timestamp ruler uses absolute aligned times that move with the viewport", () => {
  const ticks = timeline.rulerTicks({ startMs: 20000, endMs: 60000 }, 700);
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0]!.label, "0:20");
  assert.equal(ticks[2]!.timeMs, 40000);
  assert.equal(ticks[2]!.fraction, 0.5);
  const shifted = timeline.rulerTicks({ startMs: 25500, endMs: 65500 }, 700);
  assert.equal(shifted[0]!.timeMs, 30000);
  assert.equal(shifted[0]!.fraction, 0.1125);
  assert.equal(shifted[0]!.label, "0:30");
  assert(shifted.every(tick => tick.fraction >= 0 && tick.fraction <= 1));
});

test("timestamp ruler adapts label precision and density to fine zoom, long recordings, and mobile width", () => {
  const fine = timeline.rulerTicks({ startMs: 20000, endMs: 21000 }, 700);
  assert.equal(fine[1]!.label, "0:20.2");
  assert.equal(fine.at(-1)!.label, "0:21.0");
  const hours = timeline.rulerTicks({ startMs: 3600000, endMs: 7200000 }, 700);
  assert.equal(hours[0]!.label, "1:00:00");
  assert.equal(hours.at(-1)!.label, "2:00:00");
  const mobile = timeline.rulerTicks({ startMs: 0, endMs: 14400000 }, 216);
  assert(mobile.length <= 3);
  assert(mobile.every(tick => Number.isFinite(tick.fraction)));
});

test("wheel zoom keeps the hovered time anchored and respects recording and zoom limits", () => {
  const view = { startMs: 20000, endMs: 60000 };
  const zoom = timeline.zoomView(view, 0.25, 0.5, 90000);
  assert.equal(zoom.endMs - zoom.startMs, 20000);
  assert.equal(zoom.startMs + (zoom.endMs - zoom.startMs) * 0.25, 30000);
  const out = timeline.zoomView(zoom, 0.25, 2, 90000);
  assert.equal(out.startMs, view.startMs);
  assert.equal(out.endMs, view.endMs);
  assert.equal(timeline.zoomView(view, 0.5, 0.00001, 90000).endMs -
    timeline.zoomView(view, 0.5, 0.00001, 90000).startMs, 1000);
  const full = timeline.zoomView(view, 0.5, 100, 90000);
  assert.equal(full.startMs, 0);
  assert.equal(full.endMs, 90000);
  const short = timeline.zoomView({ startMs: 0, endMs: 500 }, 0.5, 0.1, 500);
  assert.equal(short.startMs, 0);
  assert.equal(short.endMs, 500);
});

test("clip timeline zoom is bounded and gives a usable local scale for multi-hour recordings", () => {
  for (const [start, end, duration] of [[60000, 110000, 14400000], [0, 25000, 180000],
    [145000, 180000, 180000], [0, 1500, 1500]]) {
    const view = timeline.viewForRange(start!, end!, duration!);
    assert(view.startMs >= 0);
    assert(view.endMs <= duration!);
    assert(view.startMs <= start! && view.endMs >= end!);
    assert(view.endMs > view.startMs);
  }
  const local = timeline.viewForRange(60000, 110000, 14400000);
  assert.equal(local.endMs - local.startMs, 80000);
});

test("pointer coordinates map to millisecond times and clamp outside the timeline", () => {
  const view = { startMs: 60000, endMs: 110000 };
  assert.equal(timeline.timeAt(0, view), 60000);
  assert.equal(timeline.timeAt(0.5, view), 85000);
  assert.equal(timeline.timeAt(1, view), 110000);
  assert.equal(timeline.timeAt(-0.5, view), 60000);
  assert.equal(timeline.timeAt(1.5, view), 110000);
  assert.equal(timeline.timeAt(0.12345, view), 66173);
});

test("dragging boundaries cannot cross each other or leave the recording", () => {
  const range = { startMs: 30000, endMs: 50000 };
  const start = timeline.moveBoundary("start", 999999, range, 60000);
  assert.equal(start.startMs, 49999);
  assert.equal(start.endMs, 50000);
  assert.equal(timeline.moveBoundary("end", 0, range, 60000).endMs, 30001);
  assert.equal(timeline.moveBoundary("start", -1, range, 60000).startMs, 0);
  assert.equal(timeline.moveBoundary("end", 90000, range, 60000).endMs, 60000);
});

test("timeline keyboard editing supports fine/coarse steps and recording limits", () => {
  assert.equal(timeline.keyboardTime("ArrowRight", 30000, 0, 60000), 30100);
  assert.equal(timeline.keyboardTime("ArrowLeft", 30000, 0, 60000, true), 29000);
  assert.equal(timeline.keyboardTime("PageUp", 30000, 0, 60000), 40000);
  assert.equal(timeline.keyboardTime("PageDown", 30000, 0, 60000), 20000);
  assert.equal(timeline.keyboardTime("ArrowLeft", 0, 0, 60000), 0);
  assert.equal(timeline.keyboardTime("ArrowRight", 59999, 0, 60000), 60000);
  assert.equal(timeline.keyboardTime("Home", 30000, 10000, 50000), 10000);
  assert.equal(timeline.keyboardTime("End", 30000, 10000, 50000), 50000);
  assert.equal(timeline.keyboardTime("Tab", 30000, 0, 60000), null);
});
