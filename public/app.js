const $ = id => document.getElementById(id);
const workspace = window.SessionScribeUI;
const accounts = window.SessionScribeAuth;
const activeStatuses = new Set(["queued", "normalizing", "uploading", "transcribing", "summarizing"]);
const activeLaughterStatuses = new Set(["queued", "running"]);
let selectedId = null;
let currentJob = null;
let lastVersion = "";
let polling = false;
let speakerDirty = false;
let busy = false;
let transcriptDraft = null;
let savingTranscript = false;
let audioKey = "";
let pendingSeek = null;
let audioFailed = false;
let selectionRequest = 0;
let deletingSession = false;
let libraryJobs = [];
let libraryLoaded = false;
let accountKey = "";
let accountVersion = 0;

function draftChanged() {
  return transcriptDraft && (transcriptDraft.text !== transcriptDraft.originalText ||
    transcriptDraft.speaker !== transcriptDraft.originalSpeaker);
}

function discardDraft() {
  if (savingTranscript) return false;
  if (draftChanged() && !confirm("Discard your unsaved transcript changes?")) return false;
  transcriptDraft = null;
  return true;
}

function updatePlayer(job) {
  $("audio-player-bar").hidden = !job;
  document.body.classList.toggle("has-player", Boolean(job));
  const key = job ? `${job.id}:${Boolean(job.audioRetained)}` : "";
  if (key === audioKey) return;
  audioKey = key;
  pendingSeek = null;
  audioFailed = false;
  const player = $("recording-player");
  player.pause();
  if (job?.audioRetained) {
    player.src = `/api/jobs/${job.id}/audio`;
    player.hidden = false;
    $("skip-back").hidden = $("skip-forward").hidden = false;
    $("audio-playback-status").textContent = "Timestamps seek the recording without starting playback.";
  } else {
    player.removeAttribute("src");
    player.hidden = true;
    $("skip-back").hidden = $("skip-forward").hidden = true;
    $("audio-playback-status").textContent = job?.demo ?
      "Fictional demo: no original recording exists." :
      job?.recordingState === "expired" ?
        "This recording was removed after its retention period. The transcript and recap are still available." :
        "Playback unavailable. Older recordings were already deleted; reupload the original to play it.";
  }
  player.load();
  $("audio-player-title").textContent = job ? `Original recording · ${job.title}` : "";
}

// Skip within the original recording; long sessions are hard to scrub precisely with the native slider.
function skipPlayback(deltaSeconds) {
  const player = $("recording-player");
  if (player.hidden || !player.src) return;
  const end = Number.isFinite(player.duration) ? player.duration : Infinity;
  player.currentTime = Math.min(end, Math.max(0, player.currentTime + deltaSeconds));
  $("audio-playback-status").textContent = `Positioned at ${time(player.currentTime * 1000)}.`;
}
$("skip-back").addEventListener("click", () => skipPlayback(-10));
$("skip-forward").addEventListener("click", () => skipPlayback(10));
document.addEventListener("keydown", event => {
  if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const target = event.target;
  // Leave Shift+arrow text selection alone in form fields and the clip editor's own controls.
  if (target instanceof HTMLElement && (target.closest("input, textarea, select, [contenteditable], dialog[open]"))) return;
  if ($("audio-player-bar").hidden || $("recording-player").hidden) return;
  event.preventDefault();
  skipPlayback(event.key === "ArrowLeft" ? -10 : 10);
});

function applySeek(seconds) {
  const player = $("recording-player");
  try {
    player.currentTime = Number.isFinite(player.duration) ? Math.min(seconds, player.duration) : seconds;
    pendingSeek = null;
    $("audio-playback-status").textContent = `Positioned at ${time(seconds * 1000)}.`;
  } catch {
    pendingSeek = null;
    $("audio-playback-status").textContent = "Unable to seek this recording. The transcript is still available.";
  }
}

function seekAndNavigate(id) {
  const segment = currentJob?.segments.find(value => value.id === id);
  if (!segment) return;
  $("search").value = "";
  renderTranscript();
  activateTab("transcript");
  const row = $(`segment-${id}`);
  if (row) {
    row.scrollIntoView({ behavior: "auto", block: "center" });
    row.classList.add("highlight");
    setTimeout(() => row.classList.remove("highlight"), 2200);
  }
  if (!currentJob.audioRetained || audioFailed) {
    message(currentJob.demo ? "Demo references navigate the transcript; no recording exists." :
      "Playback unavailable. The transcript reference is shown; reupload the original recording for playback.", "notice");
    return;
  }
  const player = $("recording-player");
  const seconds = segment.startMs / 1000;
  if (player.readyState >= 1) applySeek(seconds);
  else {
    pendingSeek = seconds;
    $("audio-playback-status").textContent = `Waiting for recording metadata to seek to ${time(segment.startMs)}…`;
  }
}

function seekLaughter(event) {
  activateTab("laughter");
  seekRecording(event.startMs);
}

function seekRecording(startMs) {
  if (!currentJob.audioRetained || audioFailed) {
    message("Playback is unavailable, but the recording timestamp remains available for reference.", "notice");
    return;
  }
  const player = $("recording-player");
  const seconds = startMs / 1000;
  if (player.readyState >= 1) applySeek(seconds);
  else {
    pendingSeek = seconds;
    $("audio-playback-status").textContent = `Waiting for recording metadata to seek to ${time(startMs)}…`;
  }
}

$("recording-player").addEventListener("loadedmetadata", () => {
  if (pendingSeek !== null) applySeek(pendingSeek);
});
$("recording-player").addEventListener("error", () => {
  if (!currentJob?.audioRetained) return;
  pendingSeek = null;
  audioFailed = true;
  $("audio-playback-status").textContent = "Recording unavailable or unsupported by this browser. Transcript navigation still works.";
});
window.addEventListener("beforeunload", event => {
  if (!draftChanged() && !savingTranscript) return;
  event.preventDefault();
  event.returnValue = "";
});

function message(text, type = "error") {
  $(type).textContent = text;
  $(type).hidden = !text;
}

function importError(text) {
  $("import-error").textContent = text;
  $("import-error").hidden = !text;
}

async function api(url, options) {
  const version = accountVersion;
  const result = await accounts.request(url, options);
  if (version !== accountVersion) throw new Error("Your account changed while the request was in progress. Try again.");
  return result;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function time(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}

function speakerName(job, id) {
  return job.speakerNames[id] || (id === "unknown" ? "Unknown" : `Speaker ${id.replace("speaker-", "")}`);
}

function knownSpeakers(job) {
  return new Set([...job.segments.map(segment => segment.speaker), ...Object.keys(job.speakerNames || {})]);
}

async function refreshList() {
  try {
    libraryJobs = await api("/api/jobs");
    libraryLoaded = true;
    renderLibrary();
  } catch (error) {
    if (!libraryLoaded) {
      $("session-list").replaceChildren(element("p", "muted", "Sessions could not be loaded. Refresh the page to retry."));
    }
    throw error;
  }
}

function renderLibrary() {
  if (!libraryLoaded) return;
  const query = $("library-search").value.trim().toLowerCase();
  const filter = $("library-filter").value;
  const jobs = libraryJobs.filter(job => {
    if (!job.title.toLowerCase().includes(query)) return false;
    if (filter === "processing") return activeStatuses.has(job.status);
    if (filter === "ready") return ["completed", "transcript_ready"].includes(job.status);
    if (filter === "failed") return job.status === "failed";
    if (filter === "demo") return job.demo;
    return true;
  });
  $("session-count").textContent = libraryJobs.length;
  $("library-empty").hidden = libraryJobs.length > 0;
  $("library-no-results").hidden = !libraryJobs.length || jobs.length > 0;
  $("session-list").replaceChildren();
  const statuses = {
    queued: "Queued", normalizing: "Preparing", uploading: "Uploading",
    transcribing: "Transcribing", summarizing: "Writing recap",
    transcript_ready: "Transcript ready", completed: "Ready", failed: "Failed",
  };
  for (const job of jobs) {
    const button = element("button", `history-item${job.id === selectedId ? " selected" : ""}`);
    button.type = "button";
    button.setAttribute("aria-current", job.id === selectedId ? "page" : "false");
    const title = element("div", "library-row-title");
    title.append(element("strong", "", job.title),
      element("span", "library-row-description", job.demo ? "Fictional sample. No Azure calls." : job.stage));
    const date = element("span", "library-row-date",
      new Date(job.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
    const state = element("span", `status-badge state-${job.demo ? "demo" : job.status}`,
      job.demo ? "Demo" : statuses[job.status]);
    const open = element("span", "library-row-open", "Open");
    open.setAttribute("aria-hidden", "true");
    button.append(title, date, state, open);
    button.addEventListener("click", () => selectJob(job.id).catch(error => message(error.message)));
    $("session-list").append(button);
  }
}

async function selectJob(id) {
  if (deletingSession) return false;
  if (id !== selectedId && !discardDraft()) return false;
  const request = ++selectionRequest;
  const job = await api(`/api/jobs/${id}`);
  if (request !== selectionRequest) return false;
  if (id !== selectedId && !discardDraft()) return false;
  const changed = selectedId !== id;
  selectedId = id;
  lastVersion = "";
  if (changed) {
    speakerDirty = false;
    $("search").value = "";
    message("", "notice");
    message("");
  }
  renderJob(job);
  workspace.showReview();
  await refreshList();
  return true;
}

function renderJob(job) {
  window.SessionScribeClips?.setJob(job);
  currentJob = job;
  lastVersion = job.updatedAt;
  $("empty-state").hidden = true;
  $("session-content").hidden = false;
  $("session-title").textContent = job.title;
  workspace.setCurrentSession(job.title);
  workspace.setRecordingState(job);
  $("session-meta").textContent = `${job.demo ? "FICTIONAL DEMO \u00b7 " : ""}${job.locale} \u00b7 ${job.durationMs ? time(job.durationMs) : "DURATION PENDING"}`;
  $("stage").textContent = job.stage;
  window.SessionScribeProgress?.render(job);
  const processing = activeStatuses.has(job.status) || activeLaughterStatuses.has(job.laughter.status);
  $("status-dot").className = `status-dot${processing ? " busy" : job.status === "failed" ? " failed" : ""}`;
  $("delete-button").disabled = processing || deletingSession;
  $("job-error").textContent = job.error || "";
  $("job-error").hidden = !job.error;
  $("warnings").replaceChildren(...job.warnings.map(warning => element("p", "", warning)));
  $("warnings").hidden = !job.warnings.length;
  $("segment-count").textContent = job.segments.length;
  $("laughter-count").textContent = job.laughter.events.length;
  const stale = Boolean(job.recap && job.recapStale);
  $("recap-dirty").hidden = !stale;
  $("recap-stale-notice").hidden = !stale;
  $("recap-stale-text").textContent = job.demo ?
    "The transcript has changed since this fictional recap. The recap is kept, but demos cannot regenerate it." :
    "The transcript has been edited since this recap was generated. Your saved recap is kept, but is out of date.";
  $("review-recap").textContent = job.demo || !job.segments.length ? "Review recap" : "Review / Regenerate recap";
  $("speaker-panel").hidden = !job.segments.length;
  $("speaker-save").disabled = processing;
  if (!speakerDirty) renderSpeakers(job, processing);
  if (!transcriptDraft) renderTranscript();
  else updateEditorControls();
  if (!deletingSession) updatePlayer(job);
  renderRecap(job);
  renderLaughter(job);
  for (const format of ["txt", "md", "srt", "json", "recap"]) {
    const link = $(`export-${format}`);
    link.hidden = format === "recap" ? !job.recap : !job.segments.length && job.status !== "transcript_ready";
    link.href = `/api/jobs/${job.id}/export/${format}`;
  }
  $("regenerate").hidden = job.demo;
  $("regenerate").disabled = processing || savingTranscript || !job.segments.length;
  $("regenerate").textContent = job.recap ? "Regenerate recap" : "Generate recap";
}

function renderSpeakers(job, processing) {
  $("speaker-fields").replaceChildren();
  for (const id of knownSpeakers(job)) {
    const label = element("label", "", id === "unknown" ? "Unknown / unassigned" : id.replace("speaker-", "Speaker "));
    const input = element("input");
    input.name = id;
    input.value = speakerName(job, id);
    input.maxLength = 100;
    input.required = true;
    input.disabled = processing;
    input.addEventListener("input", () => { speakerDirty = true; });
    label.append(input);
    $("speaker-fields").append(label);
  }
}

function updateEditorControls() {
  if (!currentJob) return;
  const disabled = savingTranscript || activeStatuses.has(currentJob.status);
  $("speaker-save").disabled = disabled;
  $("delete-button").disabled = disabled || deletingSession;
  $("regenerate").disabled = disabled || !currentJob.segments.length;
  for (const control of document.querySelectorAll(".phrase-editor textarea, .phrase-editor select, .phrase-editor button, .edit-phrase")) {
    control.disabled = disabled;
  }
}

function startEditing(segment) {
  if (activeStatuses.has(currentJob.status) || savingTranscript) return;
  if (transcriptDraft?.id === segment.id) return;
  if (!discardDraft()) return;
  transcriptDraft = {
    id: segment.id, text: segment.text, speaker: segment.speaker,
    originalText: segment.text, originalSpeaker: segment.speaker,
  };
  renderTranscript();
  $("phrase-text").focus();
}

function renderEditor() {
  const form = element("form", "phrase-editor");
  const label = element("label", "", "Phrase text");
  const input = element("textarea");
  input.id = "phrase-text";
  input.value = transcriptDraft.text;
  input.maxLength = 10000;
  input.required = true;
  input.rows = 4;
  input.addEventListener("input", () => { transcriptDraft.text = input.value; });
  label.append(input);
  const speakerLabel = element("label", "", "Entry speaker");
  const select = element("select");
  select.id = "phrase-speaker";
  for (const id of knownSpeakers(currentJob)) {
    const option = element("option", "", speakerName(currentJob, id));
    option.value = id;
    select.append(option);
  }
  select.value = transcriptDraft.speaker;
  select.addEventListener("change", () => { transcriptDraft.speaker = select.value; });
  speakerLabel.append(select);
  const actions = element("div", "edit-actions");
  const save = element("button", "secondary compact", "Save phrase");
  save.id = "phrase-save";
  save.type = "submit";
  const cancel = element("button", "quiet", "Cancel");
  cancel.id = "phrase-cancel";
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    if (!discardDraft()) return;
    renderTranscript();
  });
  const remove = element("button", "quiet danger", "Delete entry");
  remove.id = "phrase-delete";
  remove.type = "button";
  remove.addEventListener("click", deleteTranscriptEntry);
  actions.append(save, cancel, remove);
  form.append(speakerLabel, label, actions);
  form.addEventListener("submit", saveTranscript);
  return form;
}

async function saveTranscript(event) {
  event.preventDefault();
  if (!transcriptDraft || savingTranscript || activeStatuses.has(currentJob.status)) return;
  const text = transcriptDraft.text.trim();
  if (!text) {
    message("Phrase text cannot be empty.");
    $("phrase-text").focus();
    return;
  }
  const jobId = selectedId;
  const changed = text !== transcriptDraft.originalText || transcriptDraft.speaker !== transcriptDraft.originalSpeaker;
  savingTranscript = true;
  updateEditorControls();
  message("");
  try {
    const updated = await api(`/api/jobs/${jobId}/transcript`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments: [{ id: transcriptDraft.id, text, speaker: transcriptDraft.speaker }] }),
    });
    transcriptDraft = null;
    renderJob(updated);
    await refreshList();
    message(!changed || updated.recap ?
      `Transcript saved.${updated.recap ? " The existing recap was retained." : " No phrase changes were needed."}` :
      "Transcript changes saved. Exports now use the edited transcript.", "notice");
  } catch (error) { message(error.message); }
  finally {
    savingTranscript = false;
    updateEditorControls();
  }
}

async function deleteTranscriptEntry() {
  if (!transcriptDraft || savingTranscript || activeStatuses.has(currentJob.status)) return;
  if (!confirm("Delete this speaker / phrase entry? Unsaved changes to this entry will be discarded. This cannot be undone. The saved recap will be kept and marked out of date.")) return;
  const jobId = selectedId;
  const id = transcriptDraft.id;
  savingTranscript = true;
  updateEditorControls();
  message("");
  try {
    const updated = await api(`/api/jobs/${jobId}/transcript`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments: [{ id, delete: true }] }),
    });
    transcriptDraft = null;
    renderJob(updated);
    await refreshList();
    message(`Entry deleted.${updated.recap ? " Your saved recap is kept and marked out of date." : ""}`, "notice");
  } catch (error) { message(error.message); }
  finally {
    savingTranscript = false;
    updateEditorControls();
  }
}

function renderTranscript() {
  if (!currentJob) return;
  const search = $("search").value.toLowerCase();
  const segments = currentJob.segments.filter(segment =>
    segment.id === transcriptDraft?.id || `${segment.text} ${speakerName(currentJob, segment.speaker)}`.toLowerCase().includes(search),
  );
  const editorRow = transcriptDraft ? $(`segment-${transcriptDraft.id}`) : null;
  $("transcript-lines").replaceChildren();
  if (!segments.length) {
    $("transcript-lines").append(element("p", "muted", currentJob.segments.length ? "No matching lines." :
      currentJob.status === "transcript_ready" ? "All transcript entries have been deleted. The recording and saved recap are still available." :
      "The transcript will appear here when Azure finishes processing."));
  }
  for (const segment of segments) {
    if (segment.id === transcriptDraft?.id && editorRow?.querySelector(".phrase-editor")) {
      $("transcript-lines").append(editorRow);
      continue;
    }
    const row = element("article", "transcript-line");
    row.id = `segment-${segment.id}`;
    const stamp = element("button", "timestamp", time(segment.startMs));
    stamp.type = "button";
    stamp.setAttribute("aria-label", `Seek recording and show phrase at ${time(segment.startMs)}`);
    stamp.title = `${time(segment.startMs)} - ${time(segment.endMs)}`;
    stamp.addEventListener("click", () => seekAndNavigate(segment.id));
    const content = element("div");
    const name = element("div", "line-speaker", speakerName(currentJob, segment.speaker));
    if (segment.confidence !== undefined && segment.confidence < 0.75) {
      name.append(element("span", "low-confidence", "CHECK TRANSCRIPTION"));
    }
    content.append(name);
    if (segment.id === transcriptDraft?.id) content.append(renderEditor());
    else {
      const edit = element("button", "quiet edit-phrase", "Edit text / speaker");
      edit.type = "button";
      edit.setAttribute("aria-label", `Edit phrase at ${time(segment.startMs)}`);
      edit.addEventListener("click", () => startEditing(segment));
      content.append(element("p", "", segment.text), edit);
    }
    const timestampActions = element("div", "timestamp-actions");
    timestampActions.append(stamp, clipButton(segment));
    row.append(timestampActions, content);
    $("transcript-lines").append(row);
  }
  updateEditorControls();
}

function activateTab(tab) {
  for (const name of ["transcript", "laughter", "recap"]) {
    $(`${name}-tab`).classList.toggle("active", name === tab);
    $(`${name}-tab`).setAttribute("aria-selected", String(name === tab));
    $(`${name}-view`).hidden = name !== tab;
  }
}

function laughterContext(job, event) {
  const preceding = job.segments.filter(segment => segment.startMs <= event.startMs)
    .sort((a, b) => b.startMs - a.startMs)[0];
  return preceding ? `${speakerName(job, preceding.speaker)}: ${preceding.text}` : "";
}

function renderLaughter(job) {
  const analysis = job.laughter;
  const status = $("laughter-status");
  const root = $("laughter-events");
  const button = $("detect-laughter");
  root.replaceChildren();
  button.hidden = job.demo || analysis.status === "completed" && analysis.events.length > 0;
  button.disabled = activeStatuses.has(job.status) || activeLaughterStatuses.has(analysis.status) ||
    !job.audioRetained || !job.durationMs;
  button.textContent = analysis.status === "failed" ? "Retry detection" :
    analysis.status === "completed" ? "Run detection again" : "Detect laughter";
  const messages = {
    pending: "Laughter has not been analyzed yet.",
    queued: "Laughter detection is queued.",
    running: "YAMNet is analyzing the recording.",
    failed: `Detection failed: ${analysis.error || "Unknown detector error."}`,
    skipped: analysis.error || "Laughter detection is unavailable for this session.",
  };
  status.textContent = messages[analysis.status] || (analysis.events.length ?
    `${analysis.events.length} likely reaction${analysis.events.length === 1 ? "" : "s"} found.` :
    "Analysis completed without finding a reaction above the current confidence threshold.");
  for (const event of analysis.events) {
    const row = element("article", "laughter-event");
    const stamp = element("button", "timestamp laughter-timestamp", time(event.startMs));
    stamp.type = "button";
    stamp.title = `${time(event.startMs)} - ${time(event.endMs)}`;
    stamp.setAttribute("aria-label", `Seek to likely laughter at ${time(event.startMs)}`);
    stamp.addEventListener("click", () => seekLaughter(event));
    const content = element("div", "laughter-event-content");
    const heading = element("div", "laughter-event-heading");
    heading.append(element("strong", "", event.labels.map(label => label.name).join(", ")),
      element("span", "confidence-badge", `${Math.round(event.peakConfidence * 100)}% peak`));
    content.append(heading);
    const context = laughterContext(job, event);
    if (context) content.append(element("p", "laughter-context", context));
    content.append(element("p", "hint",
      `${((event.endMs - event.startMs) / 1000).toFixed(1)}s reaction · peak ${time(event.peakMs)}`));
    const clip = element("button", "quiet compact create-clip", "Create clip");
    clip.type = "button";
    clip.disabled = !job.audioRetained || !job.durationMs;
    clip.setAttribute("aria-label", `Create audio clip around laughter at ${time(event.startMs)}`);
    clip.addEventListener("click", () => window.SessionScribeClips.open(event.startMs));
    content.append(clip);
    row.append(stamp, content);
    root.append(row);
  }
}

function clipButton(segment) {
  const button = element("button", "quiet compact create-clip", "Clip");
  button.type = "button";
  button.disabled = !currentJob?.audioRetained || !currentJob?.durationMs;
  button.setAttribute("aria-label", `Create audio clip at ${time(segment.startMs)}`);
  button.addEventListener("click", () => window.SessionScribeClips.open(segment.startMs));
  return button;
}

function renderRecap(job) {
  const root = $("recap-content");
  root.replaceChildren();
  if (!job.recap) {
    root.append(element("p", "muted", job.demo ?
      "No demo recap. Regeneration is unavailable for demos and makes no cloud calls." :
      "No recap yet. Generate one from the saved transcript. The transcript is saved independently, so a recap failure never loses it."));
    return;
  }
  root.append(element("h2", "", job.recap.title));
  for (const paragraph of job.recap.paragraphs) {
    const item = element("p", "recap-paragraph", `${paragraph.text} `);
    for (const id of paragraph.segmentIds) {
      const segment = job.segments.find(value => value.id === id);
      if (!segment) {
        item.append(element("span", "muted deleted-evidence", `${id} (deleted entry) `));
        continue;
      }
      const reference = element("button", "evidence", time(segment.startMs));
      reference.type = "button";
      reference.title = `Go to ${id}: ${segment.text}`;
      reference.addEventListener("click", () => seekAndNavigate(id));
      const actions = element("span", "evidence-actions");
      actions.append(reference, clipButton(segment));
      item.append(actions);
    }
    root.append(item);
  }
  if (job.recap.uncertainties.length) {
    root.append(element("h3", "", "Uncertainties"));
    const list = element("ul");
    for (const uncertainty of job.recap.uncertainties) {
      const item = element("li", "", `${uncertainty.text} `);
      for (const id of uncertainty.segmentIds) {
        const segment = job.segments.find(value => value.id === id);
        if (!segment) {
          item.append(element("span", "muted deleted-evidence", `${id} (deleted entry) `));
          continue;
        }
        const reference = element("button", "evidence", time(segment.startMs));
        reference.type = "button";
        reference.title = `Go to ${id}: ${segment.text}`;
        reference.addEventListener("click", () => seekAndNavigate(id));
        const actions = element("span", "evidence-actions");
        actions.append(reference, clipButton(segment));
        item.append(actions);
      }
      list.append(item);
    }
    root.append(list);
  }
  if (job.recap.scenes?.length) {
    const navigation = element("details", "recap-navigation");
    navigation.append(element("summary", "", "Recording navigation"));
    navigation.append(element("p", "hint",
      "Approximate scene navigation from source-chunk time ranges, not verified citations for the prose."));
    const list = element("ul");
    for (const scene of job.recap.scenes) {
      const item = element("li");
      const reference = element("button", "evidence", `${time(scene.startMs)} - ${time(scene.endMs)}`);
      reference.type = "button";
      reference.title = `Go to source recording: ${scene.title}`;
      reference.addEventListener("click", () => seekRecording(scene.startMs));
      item.append(reference, document.createTextNode(` ${scene.title} `), clipButton(scene));
      list.append(item);
    }
    navigation.append(list);
    root.append(navigation);
  }
}

$("audio").addEventListener("change", () => {
  const file = $("audio").files[0];
  $("file-label").textContent = file ? file.name : "Choose a recording";
  if (file && !$("title").value) $("title").value = file.name.replace(/\.(mp3|opus|ogg)$/i, "").slice(0, 200);
});
$("search").addEventListener("input", renderTranscript);
$("library-search").addEventListener("input", renderLibrary);
$("library-filter").addEventListener("change", renderLibrary);
$("library-nav").addEventListener("click", () => workspace.showLibrary());
$("review-nav").addEventListener("click", () => {
  if (currentJob && !deletingSession) workspace.showReview();
});
$("review-recap").addEventListener("click", () => {
  activateTab("recap");
  const target = currentJob?.demo || !currentJob?.segments.length ? $("recap-tab") : $("regenerate");
  target.scrollIntoView({ behavior: "auto", block: "center" });
  target.focus({ preventScroll: true });
});
$("detect-laughter").addEventListener("click", async () => {
  if (!currentJob || activeStatuses.has(currentJob.status) || activeLaughterStatuses.has(currentJob.laughter.status)) return;
  const id = currentJob.id;
  $("detect-laughter").disabled = true;
  message("");
  try {
    const updated = await api(`/api/jobs/${id}/laughter`, { method: "POST" });
    if (selectedId === id) renderJob(updated);
    await refreshList();
  } catch (error) {
    message(error.message);
    if (selectedId === id) renderLaughter(currentJob);
  }
});
const sessionTabs = ["transcript", "laughter", "recap"];
for (const [index, tab] of sessionTabs.entries()) {
  $(`${tab}-tab`).addEventListener("click", () => activateTab(tab));
  $(`${tab}-tab`).addEventListener("keydown", event => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = sessionTabs[(index + offset + sessionTabs.length) % sessionTabs.length];
      activateTab(next);
      $(`${next}-tab`).focus();
    }
  });
}

// Large recordings are sent in resumable chunks: each request stays short (proxy timeouts) and a
// dropped connection resumes from the last byte the server confirmed instead of restarting.
async function uploadRecording(file, fields) {
  const json = { "Content-Type": "application/json" };
  const started = await api("/api/uploads", {
    method: "POST", headers: json, body: JSON.stringify({ ...fields, filename: file.name, size: file.size }),
  });
  let received = started.received;
  let failures = 0;
  while (received < file.size) {
    const end = Math.min(received + started.chunkBytes, file.size);
    $("upload-help").textContent = `Uploading recording: ${Math.floor(received / file.size * 100)}% of ${(file.size / 1048576).toFixed(0)} MB. Keep this page open until upload finishes.`;
    try {
      const result = await api(`/api/uploads/${started.id}/chunk?offset=${received}`, {
        method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(received, end),
      });
      received = result.received;
      failures = 0;
    } catch (error) {
      if (error.status === 401 || error.status === 403 || error.status === 404 || ++failures > 5) {
        if (error.status !== 404) await api(`/api/uploads/${started.id}`, { method: "DELETE" }).catch(() => {});
        throw error;
      }
      $("upload-help").textContent = "Connection interrupted. Resuming the upload...";
      await new Promise(resolve => setTimeout(resolve, 2000 * failures));
      received = (await api(`/api/uploads/${started.id}`)).received;
    }
  }
  $("upload-help").textContent = "Upload complete. Checking the recording...";
  return api(`/api/uploads/${started.id}/complete`, { method: "POST" });
}

$("upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  if (!discardDraft()) return;
  busy = true;
  $("upload-button").disabled = true;
  message("");
  importError("");
  try {
    const file = $("audio").files[0];
    if (!file || !file.size || file.size > 500 * 1024 * 1024 ||
        !/\.(mp3|opus|ogg)$/i.test(file.name)) throw new Error("Choose a non-empty MP3 or Ogg Opus (.opus or .ogg) file no larger than 500 MB.");
    const fields = new FormData(event.target);
    workspace.setImportBusy(true);
    const job = await uploadRecording(file, {
      title: String(fields.get("title") || ""),
      locale: String(fields.get("locale") || "en-US"),
      maxSpeakers: Number(fields.get("maxSpeakers") || 8),
      context: String(fields.get("context") || ""),
      ...(fields.get("consent") === "true" ? { consent: true } : {}),
    });    await selectJob(job.id);
    activateTab("transcript");
    workspace.closeImport();
    event.target.reset();
    $("file-label").textContent = "Choose a recording";
    message("Upload accepted. Processing continues on the server; you can close this browser tab.", "notice");
  } catch (error) {
    message(error.message);
    importError(error.message);
  }
  finally {
    busy = false;
    workspace.setImportBusy(false);
    if (!accounts.getUser()?.consentAccepted) await accounts.refresh({ background: true }).catch(() => {});
    await loadConfiguration();
  }
});
$("demo-button").addEventListener("click", async () => {
  if (!discardDraft()) return;
  $("demo-button").disabled = true;
  message("");
  try {
    const job = await api("/api/demo", { method: "POST" });
    await selectJob(job.id);
    activateTab("transcript");
    workspace.closeImport();
    message("Fictional demo opened. No Azure calls were made.", "notice");
  } catch (error) { message(error.message); }
  finally { $("demo-button").disabled = false; }
});
$("speaker-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!selectedId || savingTranscript || activeStatuses.has(currentJob.status)) return;
  savingTranscript = true;
  updateEditorControls();
  message("");
  try {
    const updated = await api(`/api/jobs/${selectedId}/speakers`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(event.target))),
    });
    speakerDirty = false;
    renderJob(updated);
    await refreshList();
    message("Speaker names saved. Any existing recap is kept; review its out-of-date marker.", "notice");
  } catch (error) { message(error.message); }
  finally {
    savingTranscript = false;
    updateEditorControls();
  }
});
$("regenerate").addEventListener("click", async () => {
  if (!selectedId || currentJob?.demo || savingTranscript || activeStatuses.has(currentJob.status)) return;
  if (!discardDraft()) return;
  renderTranscript();
  $("regenerate").disabled = true;
  message("");
  try {
    await api(`/api/jobs/${selectedId}/recap`, { method: "POST" });
    await selectJob(selectedId);
  } catch (error) { message(error.message); $("regenerate").disabled = false; }
});
$("delete-button").addEventListener("click", () => {
  if (!discardDraft()) return;
  renderTranscript();
  $("delete-dialog").showModal();
});
$("delete-dialog").addEventListener("close", async () => {
  if ($("delete-dialog").returnValue !== "delete" || !selectedId || deletingSession) return;
  const id = selectedId;
  const player = $("recording-player");
  const position = player.currentTime;
  const wasPlaying = !player.paused;
  deletingSession = true;
  ++selectionRequest;
  $("delete-button").disabled = true;
  updatePlayer(null);
  try {
    await api(`/api/jobs/${id}`, { method: "DELETE" });
    selectedId = null;
    currentJob = null;
    window.SessionScribeClips?.setJob(null);
    workspace.setCurrentSession(null);
    workspace.showLibrary();
    ++selectionRequest;
    updatePlayer(null);
    $("session-content").hidden = true;
    $("empty-state").hidden = false;
    await refreshList();
    message("Session deleted.", "notice");
  } catch (error) {
    deletingSession = false;
    updatePlayer(currentJob);
    if (currentJob?.audioRetained) {
      pendingSeek = position;
    }
    message(`${error.message}${currentJob?.audioRetained && wasPlaying ? " Recording restored paused; press play to resume." : ""}`);
  } finally {
    deletingSession = false;
    if (currentJob) $("delete-button").disabled = activeStatuses.has(currentJob.status);
  }
});

// Recording consent is acknowledged once per account (at sign-up or on the first import), not per upload.
function syncImportConsent() {
  const needed = !accounts.getUser()?.consentAccepted;
  $("import-consent").hidden = !needed;
  $("import-consent-check").required = needed;
  $("consent-reminder").hidden = needed;
}

async function loadConfiguration() {
  syncImportConsent();
  try {
    const configuration = await api("/api/config");
    $("upload-button").disabled = busy || configuration.transcriptionMissing.length > 0;
    $("upload-help").textContent = configuration.transcriptionMissing.length ?
      `Setup needed: ${configuration.transcriptionMissing.join(", ")}. The demo works without Azure.` :
      "Azure processing is billable. Multi-hour batch jobs can take minutes to hours.";
    $("storage-note").lastChild.textContent = configuration.retentionDays ?
      ` Original recordings are kept for ${configuration.retentionDays} days after upload for playback, waveforms and clip export, then deleted automatically. Transcripts, recaps, speaker names and saved clip ranges stay until you delete the session. Azure Speech only receives a temporary processing copy, deleted after transcription.` :
      " Original recordings are kept until you delete the session. Azure Speech only receives a temporary processing copy, deleted after transcription.";
    $("retention-notice").textContent = configuration.retentionDays ?
      `The original recording is kept for ${configuration.retentionDays} days for playback, waveforms and clip export, then deleted automatically. Transcripts, recaps and saved clip ranges stay until you delete the session.` :
      "The original recording is kept until you delete the session.";
    if (configuration.recapMissing.length && !configuration.transcriptionMissing.length) {
      $("upload-help").textContent += " Recap configuration is missing; transcripts will still be saved.";
    }
  } catch (error) {
    $("upload-button").disabled = true;
    $("upload-help").textContent = "Configuration could not be loaded. Refresh the page to retry.";
    message(error.message);
    importError(error.message);
  }
}

async function poll() {
  if (!accounts.canAccessWorkspace() || polling || deletingSession || !selectedId || !currentJob ||
      (!activeStatuses.has(currentJob.status) && !activeLaughterStatuses.has(currentJob.laughter.status))) return;
  polling = true;
  const id = selectedId;
  try {
    const job = await api(`/api/jobs/${id}`);
    if (selectedId === id && job.updatedAt !== lastVersion) {
      renderJob(job);
      await refreshList();
    }
  } catch (error) { message(`Status update failed: ${error.message}`); }
  finally { polling = false; }
}

accounts.guardSignOut(() => {
  if (busy || savingTranscript || deletingSession || window.SessionScribeClips?.isBusy()) {
    message("Wait for the current upload, save, deletion, or clip export to finish before signing out.");
    return false;
  }
  if (speakerDirty && !confirm("Discard your unsaved speaker name changes and sign out?")) return false;
  return discardDraft();
});
accounts.onChange(user => {
  const key = user ? `${user.id}:${user.status}:${user.role}` : "signed-out";
  if (key === accountKey) return;
  accountKey = key;
  ++accountVersion;
  ++selectionRequest;
  selectedId = null;
  currentJob = null;
  window.SessionScribeClips?.setJob(null);
  lastVersion = "";
  speakerDirty = false;
  transcriptDraft = null;
  libraryJobs = [];
  libraryLoaded = false;
  updatePlayer(null);
  workspace.setCurrentSession(null);
  $("session-content").hidden = true;
  $("empty-state").hidden = false;
  $("session-title").textContent = "";
  $("session-meta").textContent = "";
  $("stage").textContent = "";
  window.SessionScribeProgress?.render(null);
  for (const id of ["session-list", "transcript-lines", "recap-content", "speaker-fields", "warnings"]) {
    $(id).replaceChildren();
  }
  for (const format of ["txt", "md", "srt", "json", "recap"]) $(`export-${format}`).removeAttribute("href");
  $("library-search").value = "";
  $("library-filter").value = "all";
  $("search").value = "";
  $("upload-form").reset();
  $("file-label").textContent = "Choose a recording";
  $("session-count").textContent = "0";
  message("");
  message("", "notice");
  importError("");
  if (user?.status === "active") {
    Promise.all([loadConfiguration(), refreshList()]).catch(error => message(error.message));
  }
});
setInterval(poll, 3000);
