(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const auth = window.SessionScribeAuth;
  let job = null;
  let generation = 0;
  let clipId = null;
  let busy = false;
  let clips = [];
  const dialog = $("clip-dialog");
  const player = $("clip-player");
  const voices = window.SessionScribeAudio;
  voices.attach(player);
  voices.bindToggle($("clip-even-voices"));
  // One setting covers listening and exports, so what you preview is what you download.
  const exportUrl = (jobId, id) => `/api/jobs/${jobId}/clips/${id}/export${voices.enabled ? "" : "?balanced=0"}`;
  voices.onChange(() => render());
  const timeline = window.SessionScribeClipTimeline;
  const track = $("clip-track");
  let view = { startMs: 0, endMs: 1 };
  let timelineRange = { startMs: 0, endMs: 1 };
  let validRange = false;
  let pendingPosition = null;
  let drag = null;
  let manualZoom = false;
  let waveform = null;
  let waveformKey = "";
  let waveformTimer = null;
  let waveformController = null;
  let waveformSequence = 0;
  let waveformDrawKey = "";
  let rulerKey = "";
  const waveformCache = new Map();
  const format = ms => {
    const seconds = ms / 1000;
    return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
  };
  function error(text = "") {
    $("clip-error").textContent = text;
    $("clip-error").hidden = !text;
  }
  function range() {
    const startMs = Math.round($("clip-start").valueAsNumber * 1000);
    const endMs = Math.round($("clip-end").valueAsNumber * 1000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 ||
        endMs <= startMs || endMs > Math.floor(job.durationMs)) {
      throw new Error("Choose a start and end within the recording, with the end after the start.");
    }
    return { startMs, endMs };
  }
  function updateRange() {
    try {
      const value = range();
      timelineRange = value;
      validRange = true;
      if (!manualZoom && (value.startMs < view.startMs || value.endMs > view.endMs)) {
        view = timeline.viewForRange(value.startMs, value.endMs, Math.floor(job.durationMs));
      }
      $("clip-range").textContent = `${format(value.startMs)} to ${format(value.endMs)} · ${((value.endMs - value.startMs) / 1000).toFixed(3)} seconds`;
      error();
      if (player.paused) seek(pendingPosition ?? Math.round(player.currentTime * 1000));
      else enforcePreviewRange();
    } catch (cause) {
      validRange = false;
      player.pause();
      $("clip-range").textContent = "";
      error(cause.message);
    }
    renderTimeline();
    updateTransport();
  }
  function updateTransport() {
    $("clip-preview").textContent = player.paused ? "Play selection" : "Pause";
    const disabled = busy || !validRange || player.readyState < 1 || Boolean(player.error);
    $("clip-preview").disabled = disabled;
    $("clip-replay").disabled = disabled;
  }
  function renderTimeline() {
    const width = view.endMs - view.startMs;
    const percentage = value => timeline.clamp((value - view.startMs) / width * 100, 0, 100);
    const selection = $("clip-selection");
    const left = percentage(timelineRange.startMs);
    selection.style.left = `${left}%`;
    selection.style.width = `${percentage(timelineRange.endMs) - left}%`;
    for (const edge of ["start", "end"]) {
      const handle = $(`clip-${edge}-handle`);
      const value = timelineRange[`${edge}Ms`];
      handle.style.left = `${percentage(value)}%`;
      handle.hidden = value < view.startMs || value > view.endMs;
      handle.setAttribute("aria-valuemin", String(edge === "start" ? 0 : (timelineRange.startMs + 1) / 1000));
      handle.setAttribute("aria-valuemax", String(edge === "end" ? Math.floor(job?.durationMs || 1) / 1000 : (timelineRange.endMs - 1) / 1000));
      handle.setAttribute("aria-valuenow", String(value / 1000));
      handle.setAttribute("aria-valuetext", format(value));
    }
    const position = pendingPosition ?? Math.round(player.currentTime * 1000);
    const playhead = $("clip-playhead");
    playhead.style.left = `${percentage(position)}%`;
    playhead.hidden = position < view.startMs || position > view.endMs;
    playhead.setAttribute("aria-valuemin", String(timelineRange.startMs / 1000));
    playhead.setAttribute("aria-valuemax", String(timelineRange.endMs / 1000));
    playhead.setAttribute("aria-valuenow", String(timeline.clamp(position, timelineRange.startMs, timelineRange.endMs) / 1000));
    playhead.setAttribute("aria-valuetext", format(position));
    $("clip-view-start").textContent = format(view.startMs);
    $("clip-view-end").textContent = format(view.endMs);
    $("clip-position").textContent = `${format(position)} / end ${format(timelineRange.endMs)}`;
    renderRuler();
    drawWaveform();
    requestWaveform();
  }
  function renderRuler() {
    const width = track.clientWidth;
    if (!width) return;
    const key = `${view.startMs}:${view.endMs}:${width}`;
    if (key === rulerKey) return;
    rulerKey = key;
    const ruler = $("clip-ruler");
    ruler.replaceChildren();
    let lastRight = -8;
    for (const value of timeline.rulerTicks(view, width)) {
      const tick = document.createElement("span");
      tick.className = "clip-time-tick";
      tick.dataset.timeMs = String(value.timeMs);
      tick.style.left = `${value.fraction * 100}%`;
      ruler.append(tick);
      const label = document.createElement("span");
      label.className = "clip-time-label";
      label.textContent = value.label;
      tick.append(label);
      const labelWidth = label.getBoundingClientRect().width;
      const x = value.fraction * width;
      const center = timeline.clamp(x, labelWidth / 2, width - labelWidth / 2);
      if (center - labelWidth / 2 < lastRight + 8) { label.remove(); continue; }
      label.style.left = `${center - x}px`;
      lastRight = center + labelWidth / 2;
    }
  }
  function cancelWaveform() {
    clearTimeout(waveformTimer);
    waveformController?.abort();
    waveformController = null;
    waveformKey = "";
    ++waveformSequence;
  }
  function drawWaveform() {
    const canvas = $("clip-waveform");
    const width = track.clientWidth;
    const height = track.clientHeight;
    if (!width || !height) return;
    const colors = getComputedStyle(track);
    const ink = colors.getPropertyValue("--cp-text-muted").trim();
    const border = colors.getPropertyValue("--cp-border").trim();
    const key = `${waveformKey}:${Boolean(waveform)}:${view.startMs}:${view.endMs}:${width}:${height}:${ink}`;
    if (key === waveformDrawKey) return;
    waveformDrawKey = key;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.strokeStyle = border;
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();
    if (!waveform || !waveform.maxAmplitude) return;
    context.strokeStyle = ink;
    context.beginPath();
    const span = view.endMs - view.startMs;
    const binMs = (waveform.endMs - waveform.startMs) / waveform.peaks.length;
    for (let x = 0; x < width; x++) {
      const from = Math.max(0, Math.floor((view.startMs + x / width * span - waveform.startMs) / binMs));
      const to = Math.min(waveform.peaks.length, Math.ceil((view.startMs + (x + 1) / width * span - waveform.startMs) / binMs));
      let peak = 0;
      for (let index = from; index < to; index++) peak = Math.max(peak, waveform.peaks[index]);
      const amplitude = peak / waveform.maxAmplitude * (height / 2 - 6);
      context.moveTo(x + 0.5, height / 2 - amplitude);
      context.lineTo(x + 0.5, height / 2 + amplitude);
    }
    context.stroke();
  }
  function requestWaveform() {
    if (!dialog.open || !job) return;
    const padding = (view.endMs - view.startMs) / 2;
    const startMs = Math.max(0, Math.floor(view.startMs - padding));
    const endMs = Math.min(Math.floor(job.durationMs), Math.ceil(view.endMs + padding));
    const key = `${job.id}:${startMs}:${endMs}`;
    if (key === waveformKey) return;
    cancelWaveform();
    waveformKey = key;
    $("clip-waveform-retry").hidden = true;
    const cached = waveformCache.get(key);
    if (cached) {
      waveform = cached;
      waveformDrawKey = "";
      $("clip-waveform-status").textContent = "Audio amplitude envelope · 10 ms resolution.";
      drawWaveform();
      return;
    }
    $("clip-waveform-status").textContent = "Loading waveform. The first view analyzes the recording; playback remains available.";
    const version = generation;
    const sequence = waveformSequence;
    const id = job.id;
    const started = Date.now();
    const attempt = async () => {
      const controller = new AbortController();
      waveformController = controller;
      try {
        const data = await auth.request(`/api/jobs/${id}/waveform?startMs=${startMs}&endMs=${endMs}&bins=2048`,
          { signal: controller.signal });
        if (version !== generation || sequence !== waveformSequence || !dialog.open) return;
        if (data?.status === "generating") {
          // The server is still decoding a long recording in the background; check back shortly.
          const seconds = Math.round((Date.now() - started) / 1000);
          $("clip-waveform-status").textContent = `Analyzing the recording for the waveform (${seconds} s)\u2026 Long sessions can take a minute or two the first time. Playback and clipping work meanwhile.`;
          waveformTimer = setTimeout(attempt, 3000);
          return;
        }
        waveform = data;
        waveformCache.set(key, data);
        if (waveformCache.size > 8) waveformCache.delete(waveformCache.keys().next().value);
        waveformDrawKey = "";
        $("clip-waveform-status").textContent = "Audio amplitude envelope · 10 ms resolution.";
        drawWaveform();
      } catch (cause) {
        if (controller.signal.aborted || version !== generation || sequence !== waveformSequence) return;
        $("clip-waveform-status").textContent = `Waveform unavailable: ${cause.message} Clip playback and export still work.`;
        $("clip-waveform-retry").hidden = false;
      }
    };
    waveformTimer = setTimeout(attempt, 160);
  }
  $("clip-waveform-retry").addEventListener("click", () => { waveformKey = ""; requestWaveform(); });
  new ResizeObserver(() => { waveformDrawKey = ""; drawWaveform(); renderRuler(); }).observe(track);
  new MutationObserver(() => { waveformDrawKey = ""; drawWaveform(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  track.addEventListener("wheel", event => {
    if (busy || !job || drag || !event.deltaY) return;
    event.preventDefault();
    const rect = track.getBoundingClientRect();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const factor = Math.exp(timeline.clamp(event.deltaY * units / 500, -0.5, 0.5));
    view = timeline.zoomView(view, (event.clientX - rect.left) / rect.width, factor, Math.floor(job.durationMs));
    manualZoom = true;
    renderTimeline();
  }, { passive: false });
  function seek(value) {
    const position = timeline.clamp(value, timelineRange.startMs, timelineRange.endMs);
    if (player.readyState < 1) pendingPosition = position;
    else { player.currentTime = position / 1000; pendingPosition = null; }
    renderTimeline();
  }
  function ensureVisible(value) {
    const width = view.endMs - view.startMs;
    if (value >= view.startMs && value <= view.endMs) return;
    const start = timeline.clamp(value - width / 2, 0, Math.floor(job.durationMs) - width);
    view = { startMs: start, endMs: start + width };
  }
  function moveBoundary(edge, value) {
    const next = timeline.moveBoundary(edge, value, timelineRange, job.durationMs);
    $("clip-start").value = String(next.startMs / 1000);
    $("clip-end").value = String(next.endMs / 1000);
    ensureVisible(next[`${edge}Ms`]);
    updateRange();
  }
  function movePointer(event) {
    if (drag.edge === "pan") {
      view = timeline.panView(drag.view, (drag.startX - event.clientX) / drag.width, Math.floor(job.durationMs));
      renderTimeline();
      return;
    }
    const rect = track.getBoundingClientRect();
    const value = timeline.timeAt((event.clientX - rect.left) / rect.width, view) - drag.offsetMs;
    if (drag.edge === "playhead") seek(value);
    else moveBoundary(drag.edge, value);
  }
  track.addEventListener("pointerdown", event => {
    if (busy || !job || drag || !event.isPrimary || (event.button !== 0 && event.button !== 2)) return;
    if (event.button === 2) {
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      drag = { pointerId: event.pointerId, edge: "pan", startX: event.clientX, width: rect.width, view: { ...view } };
      manualZoom = true;
      track.setPointerCapture(event.pointerId);
      track.classList.add("is-panning");
      return;
    }
    const handle = event.target.closest("button");
    const edge = handle?.id === "clip-start-handle" ? "start" : handle?.id === "clip-end-handle" ? "end" : "playhead";
    event.preventDefault();
    (handle || $("clip-playhead")).focus({ preventScroll: true });
    const rect = track.getBoundingClientRect();
    const pointerTime = timeline.timeAt((event.clientX - rect.left) / rect.width, view);
    const current = edge === "playhead" ? pendingPosition ?? Math.round(player.currentTime * 1000) : timelineRange[`${edge}Ms`];
    drag = { pointerId: event.pointerId, edge, offsetMs: handle ? pointerTime - current : 0 };
    track.setPointerCapture(event.pointerId);
    track.classList.add("is-dragging");
    movePointer(event);
  });
  track.addEventListener("pointermove", event => {
    if (drag?.pointerId !== event.pointerId) return;
    const button = drag.edge === "pan" ? 2 : 1;
    if (!(event.buttons & button)) { finishDrag(); return; }
    movePointer(event);
  });
  track.addEventListener("contextmenu", event => event.preventDefault());
  function finishDrag() {
    if (drag && track.hasPointerCapture(drag.pointerId)) track.releasePointerCapture(drag.pointerId);
    drag = null;
    track.classList.remove("is-dragging");
    track.classList.remove("is-panning");
  }
  track.addEventListener("pointerup", finishDrag);
  track.addEventListener("pointercancel", finishDrag);
  track.addEventListener("lostpointercapture", finishDrag);
  window.addEventListener("blur", finishDrag);
  for (const edge of ["start", "end", "playhead"]) {
    const handle = $(edge === "playhead" ? "clip-playhead" : `clip-${edge}-handle`);
    handle.addEventListener("keydown", event => {
      if (busy || !job) return;
      const min = edge === "start" ? 0 : timelineRange.startMs + (edge === "end" ? 1 : 0);
      const max = edge === "end" ? Math.floor(job.durationMs) : timelineRange.endMs - (edge === "start" ? 1 : 0);
      const current = edge === "playhead" ? Math.round(player.currentTime * 1000) : timelineRange[`${edge}Ms`];
      const value = timeline.keyboardTime(event.key, current, min, max, event.shiftKey);
      if (value === null) return;
      event.preventDefault();
      if (edge === "playhead") { ensureVisible(value); seek(value); }
      else moveBoundary(edge, value);
    });
  }
  $("clip-zoom-selection").addEventListener("click", () => {
    manualZoom = false;
    view = timeline.viewForRange(timelineRange.startMs, timelineRange.endMs, Math.floor(job.durationMs));
    renderTimeline();
  });
  $("clip-zoom-full").addEventListener("click", () => {
    manualZoom = false;
    view = { startMs: 0, endMs: Math.floor(job.durationMs) };
    renderTimeline();
  });
  player.addEventListener("loadedmetadata", () => {
    if (!dialog.open) return;
    seek(pendingPosition ?? timelineRange.startMs);
    $("clip-playback-status").textContent = "Ready. Preview plays only the highlighted selection.";
    updateTransport();
  });
  player.addEventListener("seeking", () => {
    enforcePreviewRange();
    renderTimeline();
  });
  player.addEventListener("ended", () => { updateTransport(); renderTimeline(); });
  player.addEventListener("emptied", updateTransport);
  $("clip-replay").addEventListener("click", () => { void playSelection(true); });
  async function playSelection(restart = false) {
    try {
      range();
      if (restart || player.currentTime * 1000 < timelineRange.startMs || player.currentTime * 1000 >= timelineRange.endMs) {
        seek(timelineRange.startMs);
      }
      await player.play();
    } catch (cause) {
      $("clip-playback-status").textContent = `Cannot preview: ${cause.message}`;
    }
  }
  function setBusy(value) {
    busy = value;
    $("clip-form").setAttribute("aria-busy", String(value));
    for (const control of dialog.querySelectorAll("input, button")) control.disabled = value;
    if (value) finishDrag();
    updateTransport();
  }
  function close() { if (!busy) dialog.close(); }
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    cancelWaveform();
    finishDrag();
    player.pause();
    pendingPosition = null;
    player.removeAttribute("src");
    player.load();
  });
  $("clip-close").addEventListener("click", close);
  for (const id of ["clip-start", "clip-end"]) $(id).addEventListener("input", updateRange);
  for (const edge of ["start", "end"]) {
    $(`clip-set-${edge}`).addEventListener("click", () => {
      const value = Math.round(player.currentTime * 1000);
      moveBoundary(edge, value);
    });
  }
  function enforcePreviewRange() {
    if (!dialog.open || player.paused) return;
    try {
      const value = range();
      if (player.currentTime * 1000 < value.startMs) player.currentTime = value.startMs / 1000;
      if (player.currentTime * 1000 >= value.endMs) {
        player.pause();
        player.currentTime = value.endMs / 1000;
      }
    } catch (cause) { player.pause(); error(cause.message); }
    renderTimeline();
  }
  player.addEventListener("timeupdate", () => { enforcePreviewRange(); renderTimeline(); });
  let previewTimer = null;
  player.addEventListener("pause", () => {
    clearInterval(previewTimer);
    previewTimer = null;
    updateTransport();
    renderTimeline();
  });
  player.addEventListener("play", () => {
    try {
      const value = range();
      if (player.currentTime * 1000 < value.startMs || player.currentTime * 1000 >= value.endMs) {
        player.currentTime = value.startMs / 1000;
      }
      clearInterval(previewTimer);
      previewTimer = setInterval(enforcePreviewRange, 25);
      updateTransport();
    } catch (cause) { player.pause(); error(cause.message); }
  });
  player.addEventListener("error", () => {
    if (dialog.open) $("clip-playback-status").textContent =
      "Recording unavailable or unsupported by this browser. MP3 export may still work if the original exists.";
    updateTransport();
  });
  $("clip-preview").addEventListener("click", () => {
    if (player.paused) void playSelection();
    else player.pause();
  });
  function open(timestamp, existing = null) {
    if (!job?.audioRetained || !job.durationMs || busy) return;
    $("recording-player").pause();
    clipId = existing?.id || null;
    $("clip-name").value = existing?.name || "";
    $("clip-title").textContent = existing ? "Edit clip" : "Create clip";
    $("clip-context").textContent = `${job.title} · recording length ${format(job.durationMs)}`;
    $("clip-start").max = $("clip-end").max = String(Math.floor(job.durationMs) / 1000);
    $("clip-start").value = String((existing?.startMs ?? Math.max(0, Math.min(timestamp, job.durationMs) - 30000)) / 1000);
    $("clip-end").value = String((existing?.endMs ?? Math.min(Math.floor(job.durationMs), timestamp + 20000)) / 1000);
    $("clip-status").textContent = "";
    manualZoom = false;
    cancelWaveform();
    $("clip-playback-status").textContent = "Loading recording for preview...";
    view = timeline.viewForRange($("clip-start").valueAsNumber * 1000, $("clip-end").valueAsNumber * 1000, Math.floor(job.durationMs));
    pendingPosition = Math.round($("clip-start").valueAsNumber * 1000);
    if (!dialog.open) dialog.showModal();
    player.src = `/api/jobs/${job.id}/audio`;
    player.load();
    updateRange();
    $("clip-start-handle").focus();
  }
  function render() {
    const root = $("clip-list");
    root.replaceChildren();
    if (!clips.length) {
      root.textContent = job?.audioRetained ? "No clips yet. Use Clip beside a timestamp." : "No clips. A retained recording is needed.";
      return;
    }
    for (const clip of clips) {
      const row = document.createElement("div");
      row.className = "saved-clip";
      const title = document.createElement("strong");
      title.textContent = clip.name || "Unnamed clip";
      const times = document.createElement("div");
      times.className = "hint";
      times.textContent = `${format(clip.startMs)} - ${format(clip.endMs)}`;
      const actions = document.createElement("div");
      actions.className = "saved-clip-actions";
      const edit = document.createElement("button");
      edit.className = "quiet compact";
      edit.textContent = "Edit / preview";
      edit.type = "button";
      edit.disabled = !job.audioRetained;
      edit.addEventListener("click", () => open(clip.startMs, clip));
      actions.append(edit);
      if (job.audioRetained) {
        const link = document.createElement("a");
        link.className = "quiet compact";
        link.href = exportUrl(job.id, clip.id);
        link.textContent = "Export MP3";
        actions.append(link);
      } else {
        const note = document.createElement("span");
        note.textContent = "Recording unavailable; range retained.";
        actions.append(note);
      }
      row.append(title, times, actions);
      root.append(row);
    }
  }
  async function save(exportAudio) {
    if (busy || !job) return;
    const version = generation;
    const id = job.id;
    try {
      if (!$("clip-form").reportValidity()) return;
      const value = { ...range(), name: $("clip-name").value.trim() };
      setBusy(true);
      error();
      $("clip-status").textContent = "Saving clip...";
      const saved = await auth.request(`/api/jobs/${id}/clips${clipId ? `/${clipId}` : ""}`, {
        method: clipId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
      });
      if (version !== generation) return;
      clipId = saved.id;
      $("clip-name").value = saved.name;
      clips = [...clips.filter(clip => clip.id !== saved.id), saved];
      render();
      $("clip-status").textContent = "Clip saved.";
      if (exportAudio) {
        $("clip-status").textContent = "Clip saved. Preparing MP3...";
        const response = await fetch(exportUrl(id, saved.id));
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error || "Clip export failed.");
        }
        const disposition = response.headers.get("Content-Disposition") || "";
        const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
        const plainName = /filename="([^"]+)"/i.exec(disposition);
        const filename = encodedName ? decodeURIComponent(encodedName[1]) : plainName?.[1];
        if (!filename) throw new Error("Clip export did not provide a download filename.");
        const blob = await response.blob();
        if (version !== generation) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        $("clip-status").textContent = "Clip saved. MP3 download ready.";
      }
    } catch (cause) { if (version === generation) error(cause.message); }
    finally { setBusy(false); }
  }
  $("clip-form").addEventListener("submit", event => { event.preventDefault(); void save(false); });
  $("clip-export").addEventListener("click", () => { void save(true); });
  window.SessionScribeClips = {
    open,
    isBusy: () => busy,
    setJob(next) {
      const changed = job?.id !== next?.id;
      job = next;
      if (!changed) { render(); return; }
      const version = ++generation;
      cancelWaveform();
      waveform = null;
      waveformCache.clear();
      waveformDrawKey = "";
      dialog.close();
      player.pause();
      player.removeAttribute("src");
      player.load();
      clips = [];
      render();
      if (!job) return;
      $("clip-list").textContent = "Loading clips...";
      auth.request(`/api/jobs/${job.id}/clips`).then(result => {
        if (version !== generation) return;
        clips = result;
        render();
      }).catch(cause => {
        if (version === generation) $("clip-list").textContent = `Could not load clips: ${cause.message}`;
      });
    },
  };
})();
