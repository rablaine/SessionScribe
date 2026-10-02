(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const importDialog = byId("import-dialog");
  const previewDialog = byId("preview-dialog");
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

  function setRecordingState({ available, demo }) {
    byId("recording-state").textContent = demo ? "Fictional demo · no recording" :
      available ? "Stored on this device" : "Unavailable";
    byId("recording-detail").textContent = demo ?
      "No audio was recorded or processed for this demo. References navigate its fictional transcript." :
      available ?
        "The local original remains on this device until you delete the session. Use playback controls or transcript timestamps to review it. Planned 30-day retention is not active." :
        "No local original is available for playback. The transcript and saved recap can still be reviewed. Current originals remain until session deletion; planned 30-day retention is not active.";
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

  const previewTabs = [...document.querySelectorAll("[data-preview-tab]")];
  function closePreview() {
    if (previewDialog.open) previewDialog.close();
  }
  function selectPreview(name, focus = false) {
    const selected = previewTabs.some(tab => tab.dataset.previewTab === name) ? name : "recordings";
    previewTabs.forEach(tab => {
      const active = tab.dataset.previewTab === selected;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      byId(tab.getAttribute("aria-controls")).hidden = !active;
      if (active && focus) tab.focus();
    });
  }
  document.querySelectorAll("[data-open-preview]").forEach(button => {
    button.addEventListener("click", () => {
      selectPreview(button.dataset.openPreview);
      if (!previewDialog.open) previewDialog.showModal();
    });
  });
  document.querySelectorAll("[data-close-preview]").forEach(button => {
    button.addEventListener("click", closePreview);
  });
  previewDialog.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !previewDialog.open) return;
    event.preventDefault();
    closePreview();
  });
  previewTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectPreview(tab.dataset.previewTab));
    tab.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % previewTabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + previewTabs.length) % previewTabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = previewTabs.length - 1;
      else return;
      event.preventDefault();
      selectPreview(previewTabs[next].dataset.previewTab, true);
    });
  });
  previewDialog.querySelectorAll("form").forEach(form => {
    form.addEventListener("submit", event => event.preventDefault());
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
