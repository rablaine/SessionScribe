(() => {
  "use strict";
  // Progress for long-running server work. Durations are estimates learned from earlier runs, so the bar is
  // deliberately approximate: completed steps are real, the current step fills on a curve that never quite
  // reaches 100% until the server reports it done.
  const byId = id => document.getElementById(id);
  let current = null;
  let ticker = null;

  const ICONS = { done: "\u2713", running: "\u25cf", pending: "\u25cb", failed: "\u2715" };
  const RUN_TITLES = { process: "Processing this session", recap: "Generating the recap", laughter: "Detecting laughter" };
  // What each step makes available, so people know which tools to wait for instead of assuming something is broken.
  const UNLOCKS = {
    laughter: "laughter index",
    waveform: "clip editor waveform",
    transcribe: "transcript, search, speaker names and exports",
    recap: "story recap",
  };

  function duration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  }

  function stepFraction(step, now) {
    if (step.status === "done" || step.status === "skipped") return 1;
    if (step.status !== "running") return 0;
    const elapsed = Math.max(0, now - Date.parse(step.startedAt || "") || 0);
    const estimate = Math.max(step.estimateMs || 0, 2000);
    const timed = Math.min(0.95, 1 - Math.exp(-1.6 * elapsed / estimate));
    return typeof step.fraction === "number" ? Math.max(step.fraction, Math.min(timed, step.fraction + 0.1)) : timed;
  }

  // Laughter and waveform run alongside transcription and recap, so time left follows the longer branch.
  const PARALLEL_SIDE = new Set(["laughter", "waveform"]);
  const PARALLEL_MAIN = new Set(["transcribe", "recap"]);

  function summarize(progress, now) {
    const steps = progress.steps.filter(step => step.status !== "skipped");
    let total = 0, completed = 0, overdue = false;
    const remaining = { serial: 0, side: 0, main: 0 };
    for (const step of steps) {
      const weight = Math.max(step.estimateMs || 0, 2000);
      total += weight;
      completed += weight * stepFraction(step, now);
      let left = 0;
      if (step.status === "pending") left = weight;
      if (step.status === "running") {
        const elapsed = now - Date.parse(step.startedAt || "");
        left = Math.max(weight - elapsed, 0);
        if (elapsed > weight * 1.2) overdue = true;
      }
      remaining[PARALLEL_SIDE.has(step.key) ? "side" : PARALLEL_MAIN.has(step.key) ? "main" : "serial"] += left;
    }
    return {
      percent: total ? Math.min(99, Math.round(completed / total * 100)) : 0,
      remaining: remaining.serial + Math.max(remaining.side, remaining.main), overdue, steps,
    };
  }

  function etaText({ remaining, overdue }) {
    if (overdue) return "Taking longer than usual\u2026";
    if (remaining < 60_000) return "Less than a minute left (estimate)";
    return `About ${Math.round(remaining / 60_000)} min left (estimate)`;
  }

  function renderSteps(progress, now) {
    const list = byId("run-progress-steps");
    list.replaceChildren();
    for (const step of progress.steps) {
      if (step.status === "skipped") continue;
      const item = document.createElement("li");
      item.className = `progress-step ${step.status}`;
      const icon = document.createElement("span");
      icon.className = "progress-step-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = ICONS[step.status] || "";
      const label = document.createElement("span");
      label.className = "progress-step-label";
      label.textContent = step.label;
      if (UNLOCKS[step.key]) {
        const unlocks = document.createElement("span");
        unlocks.className = "progress-step-unlocks";
        unlocks.textContent = step.status === "done" ? `Ready: ${UNLOCKS[step.key]}` :
          step.status === "failed" ? `Not available: ${UNLOCKS[step.key]}` : `Unlocks: ${UNLOCKS[step.key]}`;
        label.append(unlocks);
      }
      const meta = document.createElement("span");
      meta.className = "progress-step-meta";
      if (step.status === "done" && step.startedAt && step.endedAt) {
        meta.textContent = duration(Date.parse(step.endedAt) - Date.parse(step.startedAt));
      } else if (step.status === "running" && step.startedAt) {
        meta.textContent = `${step.detail ? `${step.detail} \u00b7 ` : ""}${duration(now - Date.parse(step.startedAt))}`;
      } else if (step.status === "failed") {
        meta.textContent = step.detail || "Failed";
      } else if (step.status === "pending" && step.detail) {
        meta.textContent = step.detail;
      }
      const state = document.createElement("span");
      state.className = "visually-hidden";
      state.textContent = { done: "Completed: ", running: "In progress: ", pending: "Waiting: ", failed: "Failed: " }[step.status] || "";
      item.append(icon, state, label, meta);
      list.append(item);
    }
  }

  function paint() {
    const panel = byId("run-progress");
    const progress = current?.progress;
    if (!progress || current.demo) { panel.hidden = true; return; }
    const now = Date.now();
    const running = !progress.finishedAt;
    panel.hidden = false;
    panel.classList.toggle("finished", !running);
    byId("run-progress-track").hidden = !running;
    renderSteps(progress, now);
    const waiting = progress.steps.filter(step => (step.status === "pending" || step.status === "running") && UNLOCKS[step.key])
      .map(step => UNLOCKS[step.key]);
    byId("run-progress-pending").hidden = !running || !waiting.length;
    byId("run-progress-pending").textContent = waiting.length
      ? `Not ready yet: ${waiting.join("; ")}. Each appears as its step finishes. You can play the recording now.`
      : "";
    if (running) {
      const summary = summarize(progress, now);
      byId("run-progress-title").textContent = RUN_TITLES[progress.kind] || "Processing";
      byId("run-progress-eta").textContent = `${summary.percent}% \u00b7 ${etaText(summary)}`;
      byId("run-progress-fill").style.width = `${summary.percent}%`;
      byId("run-progress-track").setAttribute("aria-valuenow", String(summary.percent));
      byId("run-progress-details").open = true;
    } else {
      const total = Date.parse(progress.finishedAt) - Date.parse(progress.startedAt);
      byId("run-progress-title").textContent = progress.outcome === "failed" ? "Last run stopped with an error" : "Last run completed";
      byId("run-progress-eta").textContent = Number.isFinite(total) ? `in ${duration(total)}` : "";
    }
  }

  function render(job) {
    const wasRunning = current?.progress && !current.progress.finishedAt;
    const previousRun = current?.id === job?.id ? current?.progress?.startedAt : undefined;
    current = job || null;
    const running = Boolean(current?.progress && !current.progress.finishedAt);
    // Collapse the step list once a run ends (or when opening a session whose run already finished).
    if (!running && (wasRunning || previousRun !== current?.progress?.startedAt)) byId("run-progress-details").open = false;
    paint();
    if (running && !ticker) ticker = setInterval(paint, 1000);
    if (!running && ticker) { clearInterval(ticker); ticker = null; }
  }

  window.SessionScribeProgress = Object.freeze({ render, summarize });
})();
