(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const importDialog = byId("import-dialog");
  let importBusy = false;
  let currentSession = null;

  function hideAccountViews() {
    for (const id of ["auth-view", "access-view", "admin-view"]) byId(id).hidden = true;
    byId("admin-nav").classList.remove("active");
    byId("admin-nav").removeAttribute("aria-current");
  }

  function showLibrary() {
    if (!window.SessionScribeAuth?.canAccessWorkspace()) return false;
    hideAccountViews();
    byId("library-view").hidden = false;
    byId("session-panel").hidden = true;
    byId("library-nav").classList.add("active");
    byId("library-nav").setAttribute("aria-current", "page");
    byId("review-nav").classList.remove("active");
    byId("review-nav").removeAttribute("aria-current");
    return true;
  }

  function showReview() {
    if (!window.SessionScribeAuth?.canAccessWorkspace()) return false;
    hideAccountViews();
    byId("library-view").hidden = true;
    byId("session-panel").hidden = false;
    byId("review-nav").hidden = currentSession === null;
    byId("review-nav").classList.add("active");
    byId("review-nav").setAttribute("aria-current", "page");
    byId("library-nav").classList.remove("active");
    byId("library-nav").removeAttribute("aria-current");
    return true;
  }

  function showAdmin() {
    if (!window.SessionScribeAuth?.canAccessWorkspace() ||
        window.SessionScribeAuth.getUser()?.role !== "admin") return false;
    hideAccountViews();
    byId("library-view").hidden = true;
    byId("session-panel").hidden = true;
    byId("admin-view").hidden = false;
    for (const id of ["library-nav", "review-nav"]) {
      byId(id).classList.remove("active");
      byId(id).removeAttribute("aria-current");
    }
    byId("admin-nav").classList.add("active");
    byId("admin-nav").setAttribute("aria-current", "page");
    return true;
  }

  function setCurrentSession(titleOrNull) {
    currentSession = titleOrNull === null ? null : String(titleOrNull);
    byId("current-session-label").textContent = currentSession || "Session review";
    byId("review-nav").hidden = currentSession === null;
    if (currentSession === null) byId("review-nav").removeAttribute("title");
    else byId("review-nav").title = currentSession;
  }

  function closeImport() {
    if (importDialog.open) importDialog.close();
  }

  function setImportBusy(value) {
    importBusy = Boolean(value);
    byId("upload-form").setAttribute("aria-busy", String(importBusy));
    importDialog.querySelectorAll("[data-close-import]").forEach(button => {
      button.disabled = importBusy;
    });
  }

  const DAY = 86_400_000;
  const dateText = value => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  function setRecordingState(job) {
    const state = byId("recording-state");
    const detail = byId("recording-detail");
    const footnote = byId("recording-footnote");
    const download = byId("recording-download");
    download.hidden = true;
    download.removeAttribute("href");
    state.classList.remove("expiring");
    footnote.textContent = "";
    if (!job) {
      state.textContent = "No session selected";
      detail.textContent = "Select a session to check whether its original recording is available.";
      return;
    }
    const recording = job.recordingState;
    if (recording === "none") {
      state.textContent = "Fictional demo · no recording";
      detail.textContent = "No audio was recorded or processed for this demo. References navigate its fictional transcript.";
      return;
    }
    if (recording === "available") {
      download.href = `/api/jobs/${encodeURIComponent(job.id)}/audio?download=1`;
      download.hidden = false;
      if (!job.recordingExpiresAt) {
        state.textContent = "Available";
        detail.textContent = "The original is kept until you delete this session.";
        return;
      }
      const remaining = Math.max(0, Math.ceil((Date.parse(job.recordingExpiresAt) - Date.now()) / DAY));
      const soon = remaining <= 7;
      state.textContent = soon ? `Expiring soon · ${remaining} day${remaining === 1 ? "" : "s"} left` : `Available · ${remaining} days left`;
      state.classList.toggle("expiring", soon);
      detail.textContent = `Uploaded ${dateText(job.recordingUploadedAt || job.createdAt)}. Playback, waveform and clip export are available until ${dateText(job.recordingExpiresAt)}.` +
        (soon ? " Download the original or export the clips you want to keep before then." : "");
      footnote.textContent = "Originals are deleted automatically after the retention period. Transcripts, recaps, speaker names and saved clip ranges stay until you delete the session. Editing or playing does not extend the deadline.";
      return;
    }
    if (recording === "expired") {
      state.textContent = "Recording removed";
      detail.textContent = "This recording was removed after its retention period. Your transcript and recap are still available; saved clip ranges are kept but can no longer be played or exported.";
      return;
    }
    state.textContent = "Unavailable";
    detail.textContent = "No original recording is stored for this session (older versions deleted it after processing). The transcript and saved recap can still be reviewed; upload the recording again as a new session for playback.";
  }
  document.querySelectorAll("[data-open-import]").forEach(button => {
    button.addEventListener("click", () => {
      if (!window.SessionScribeAuth?.canAccessWorkspace()) return;
      if (!importDialog.open) importDialog.showModal();
    });
  });
  document.querySelectorAll("[data-close-import]").forEach(button => {
    button.addEventListener("click", () => {
      if (!importBusy) closeImport();
    });
  });
  importDialog.addEventListener("cancel", event => {
    if (importBusy) event.preventDefault();
  });
  importDialog.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !importDialog.open) return;
    event.preventDefault();
    if (!importBusy) closeImport();
  });

  const themeToggle = byId("theme-toggle");
  let manualTheme = false;
  function updateThemeLabel() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    themeToggle.setAttribute("aria-pressed", String(dark));
    themeToggle.textContent = "Dark appearance";
    themeToggle.title = dark ? "Switch to light appearance" : "Switch to dark appearance";
  }
  themeToggle.addEventListener("click", () => {
    manualTheme = true;
    document.documentElement.setAttribute("data-theme",
      document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
    updateThemeLabel();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", event => {
    if (manualTheme || new URLSearchParams(window.location.search).get("scoutTheme")) return;
    document.documentElement.setAttribute("data-theme", event.matches ? "dark" : "light");
    updateThemeLabel();
  });
  updateThemeLabel();

  window.SessionScribeUI = Object.freeze({
    showLibrary, showReview, showAdmin, setCurrentSession, closeImport, setImportBusy, setRecordingState,
  });
})();
