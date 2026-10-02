(() => {
  "use strict";
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function viewForRange(startMs, endMs, durationMs) {
    const width = Math.min(durationMs, Math.max(10000, (endMs - startMs) * 1.6));
    const start = clamp((startMs + endMs - width) / 2, 0, durationMs - width);
    return { startMs: start, endMs: start + width };
  }
  function timeAt(fraction, view) {
    return Math.round(view.startMs + clamp(fraction, 0, 1) * (view.endMs - view.startMs));
  }
  function zoomView(view, fraction, factor, durationMs) {
    const anchor = clamp(fraction, 0, 1);
    const width = clamp((view.endMs - view.startMs) * factor, Math.min(1000, durationMs), durationMs);
    const point = view.startMs + anchor * (view.endMs - view.startMs);
    const start = clamp(point - anchor * width, 0, durationMs - width);
    return { startMs: start, endMs: start + width };
  }
  function panView(view, fraction, durationMs) {
    const width = view.endMs - view.startMs;
    const start = clamp(view.startMs + fraction * width, 0, durationMs - width);
    return { startMs: start, endMs: start + width };
  }
  function rulerTicks(view, pixelWidth) {
    const width = view.endMs - view.startMs;
    const desired = width / Math.max(2, Math.floor(pixelWidth / 100));
    const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000,
      60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 14400000];
    const step = steps.find(value => value >= desired) || steps[steps.length - 1];
    const ticks = [];
    for (let ms = Math.ceil(view.startMs / step) * step; ms <= view.endMs; ms += step) {
      const seconds = Math.floor(ms / 1000);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor(seconds / 60);
      const clock = hours ? `${hours}:${String(minutes % 60).padStart(2, "0")}` : String(minutes);
      const label = `${clock}:${String(seconds % 60).padStart(2, "0")}${step < 1000 ? `.${Math.floor(ms % 1000 / 100)}` : ""}`;
      ticks.push({ timeMs: ms, fraction: (ms - view.startMs) / width, label });
    }
    return ticks;
  }
  function moveBoundary(edge, value, range, durationMs) {
    return edge === "start"
      ? { startMs: clamp(Math.round(value), 0, range.endMs - 1), endMs: range.endMs }
      : { startMs: range.startMs, endMs: clamp(Math.round(value), range.startMs + 1, Math.floor(durationMs)) };
  }
  function keyboardTime(key, current, min, max, shift = false) {
    const step = shift ? 1000 : 100;
    const changes = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step,
      PageDown: -10000, PageUp: 10000 };
    if (key === "Home") return min;
    if (key === "End") return max;
    if (!(key in changes)) return null;
    return clamp(current + changes[key], min, max);
  }
  window.SessionScribeClipTimeline = Object.freeze({ clamp, viewForRange, timeAt, zoomView, panView, rulerTicks, moveBoundary, keyboardTime });
})();
