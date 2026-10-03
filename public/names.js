(() => {
  "use strict";
  // Names & spelling tab (account names list, fixes for the open transcript, AI suggestion review) and the
  // recap tab's "Corrections for the next recap". app.js supplies its helpers through init().
  const $ = id => document.getElementById(id);
  let hooks = null;
  let job = null;
  let list = null;
  let rows = [];
  let listDirty = false;
  let listLoading = null;
  let preview = null;
  let working = false;
  let unchecked = new Set();
  let reviewKey = "";
  let corrections = [];
  let correctionsDirty = false;
  let correctionsJob = "";

  const el = (tag, className, text) => hooks.element(tag, className, text);
  const status = (id, text) => { $(id).textContent = text || ""; };

  function splitVariants(value) {
    return value.split(/[,;\n]/).map(part => part.trim()).filter(Boolean);
  }

  // Shows only the changed part of a line, with a little context either side.
  function diff(before, after) {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    // Expand to whole words so "Lonelywood" -> "Lostleton" reads naturally.
    while (start > 0 && /[\p{L}\p{N}]/u.test(before[start - 1])) start--;
    while (end > 0 && /[\p{L}\p{N}]/u.test(before[before.length - end])) end--;
    const fragment = document.createDocumentFragment();
    const prefix = before.slice(0, start);
    const suffix = before.slice(before.length - end);
    fragment.append(prefix.length > 60 ? `\u2026${prefix.slice(-60)}` : prefix);
    fragment.append(el("del", "", before.slice(start, before.length - end)));
    fragment.append(el("ins", "", after.slice(start, after.length - end)));
    fragment.append(suffix.length > 60 ? `${suffix.slice(0, 60)}\u2026` : suffix);
    return fragment;
  }
  function inline(text, before, after) {
    const index = text.indexOf(before);
    return index < 0 ? document.createTextNode(text) : diff(text, text.slice(0, index) + after + text.slice(index + before.length));
  }

  // ---- Names list (account-wide) ----
  async function loadList() {
    listLoading ??= hooks.api("/api/names").then(result => {
      list = result;
      if (!listDirty) {
        rows = result.entries.map(entry => ({ term: entry.term, variants: entry.variants.join(", ") }));
        $("names-auto").checked = result.autoApply;
      }
      renderList();
      renderFix();
    }).catch(error => status("names-status", `Names list could not be loaded: ${error.message}`))
      .finally(() => { listLoading = null; });
    return listLoading;
  }

  function markDirty() {
    listDirty = true;
    $("names-save").disabled = working;
    status("names-status", "Unsaved changes");
  }

  function renderList() {
    const root = $("names-rows");
    root.replaceChildren();
    if (!rows.length) rows.push({ term: "", variants: "" });
    const header = el("div", "names-row names-row-header");
    header.append(el("span", "", "Correct spelling"), el("span", "", "Heard as (comma-separated)"), el("span"));
    header.setAttribute("aria-hidden", "true");
    root.append(header);
    rows.forEach((row, index) => {
      const line = el("div", "names-row");
      const term = el("input");
      term.value = row.term;
      term.maxLength = 80;
      term.placeholder = "e.g. Lostleton";
      term.setAttribute("aria-label", `Correct spelling ${index + 1}`);
      term.addEventListener("input", () => { row.term = term.value; markDirty(); });
      const variants = el("input");
      variants.value = row.variants;
      variants.placeholder = "e.g. Lonelywood, Lost Elton";
      variants.setAttribute("aria-label", `Heard as, for ${row.term || `name ${index + 1}`}`);
      variants.addEventListener("input", () => { row.variants = variants.value; markDirty(); });
      const remove = el("button", "quiet compact", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${row.term || `name ${index + 1}`}`);
      remove.addEventListener("click", () => { rows.splice(index, 1); markDirty(); renderList(); });
      line.append(term, variants, remove);
      root.append(line);
    });
    $("names-save").disabled = !listDirty || working;
  }

  function draftEntries() {
    return rows.filter(row => row.term.trim()).map(row => ({ term: row.term.trim(), variants: splitVariants(row.variants) }));
  }

  async function saveList() {
    const entries = draftEntries();
    const invalid = entries.find(entry => entry.term.length > 80 || entry.variants.length > 12 || entry.variants.some(value => value.length > 80));
    if (invalid) throw new Error(`"${invalid.term.slice(0, 40)}": names and spellings are limited to 80 characters, with up to 12 "heard as" spellings each.`);
    list = await hooks.api("/api/names", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries, autoApply: $("names-auto").checked }),
    });
    listDirty = false;
    rows = list.entries.map(entry => ({ term: entry.term, variants: entry.variants.join(", ") }));
    preview = null;
    renderList();
    status("names-status", "Names list saved.");
  }

  async function ensureSaved() {
    if (listDirty) await saveList();
    if (!list) await loadList();
  }

  // ---- Fixing the open transcript ----
  function editable() {
    return Boolean(job && hooks.canEdit() && job.segments.length && !working);
  }

  function renderFix() {
    if (!hooks || !job) return;
    const canEdit = editable();
    const hasNames = draftEntries().length > 0;
    $("names-preview").disabled = !canEdit || !draftEntries().some(entry => entry.variants.length);
    $("names-suggest").disabled = !canEdit || job.demo || !hasNames;
    $("names-suggest").title = job.demo ? "The fictional demo can't use Azure." : !hasNames ? "Add at least one name first." : "";
    const pending = job.nameSuggestions?.items.length ?? 0;
    $("names-count").hidden = !pending;
    $("names-count").textContent = pending ? `${pending} to review` : "";
    const root = $("names-result");
    root.replaceChildren();
    if (!job.segments.length) {
      root.append(el("p", "muted", "Names can be fixed once the transcript is ready."));
      return;
    }
    if (job.status === "checking_names" || job.queuedOperation === "names") {
      root.append(el("p", "notice", "Looking for misheard names. Suggestions appear here when ready; you can keep reading meanwhile."));
      return;
    }
    if (job.nameSuggestions) { renderReview(root); return; }
    if (preview?.jobId === job.id) renderPreview(root);
  }

  function renderPreview(root) {
    const panel = el("div", "names-panel");
    if (!preview.count) {
      panel.append(el("p", "", "Nothing to fix: none of your \u201cheard as\u201d spellings appear in this transcript."));
      const close = el("button", "quiet compact", "OK");
      close.type = "button";
      close.addEventListener("click", () => { preview = null; renderFix(); });
      panel.append(close);
      root.append(panel);
      return;
    }
    panel.append(el("h3", "", `${preview.count} fix${preview.count === 1 ? "" : "es"} on ${preview.lines} line${preview.lines === 1 ? "" : "s"}`));
    const listNode = el("ul", "names-changes");
    for (const change of preview.examples) {
      const item = el("li");
      const stamp = el("button", "timestamp", hooks.time(change.startMs));
      stamp.type = "button";
      stamp.setAttribute("aria-label", `Play from ${hooks.time(change.startMs)}`);
      stamp.addEventListener("click", () => hooks.seekTime(change.startMs));
      const text = el("span", "names-line");
      text.append(diff(change.before, change.after));
      item.append(stamp, text);
      listNode.append(item);
    }
    panel.append(listNode);
    if (preview.lines > preview.examples.length) panel.append(el("p", "hint", `Showing the first ${preview.examples.length} of ${preview.lines} lines.`));
    const actions = el("div", "names-review-actions");
    const apply = el("button", "primary compact", `Apply ${preview.count} fix${preview.count === 1 ? "" : "es"}`);
    apply.type = "button";
    apply.disabled = !editable();
    apply.addEventListener("click", () => void run(async () => {
      const { count } = preview;
      const updated = await hooks.api(`/api/jobs/${job.id}/names/apply`, { method: "POST" });
      preview = null;
      hooks.show(updated);
      hooks.message(`Fixed ${count} name${count === 1 ? "" : "s"}.${updated.recap ? " Regenerate the recap to use them." : ""}`, "notice");
    }));
    const cancel = el("button", "quiet compact", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => { preview = null; renderFix(); });
    actions.append(apply, cancel);
    panel.append(actions);
    root.append(panel);
  }

  function renderReview(root) {
    const suggestions = job.nameSuggestions;
    const key = `${job.id}:${suggestions.createdAt}`;
    if (key !== reviewKey) { reviewKey = key; unchecked = new Set(); }
    const panel = el("div", "names-panel");
    const items = suggestions.items;
    panel.append(el("h3", "", items.length ? `${items.length} suggested fix${items.length === 1 ? "" : "es"} to review` : "No misheard names found"));
    if (suggestions.skipped.length) {
      panel.append(el("p", "hint", `Not checked (Azure's content filter): ${suggestions.skipped.join(", ")}.`));
    }
    const byId = new Map(job.segments.map(segment => [segment.id, segment]));
    if (items.length) {
      const toolbar = el("div", "names-review-toolbar");
      const all = el("button", "quiet compact", "Select all");
      all.type = "button";
      all.addEventListener("click", () => { unchecked = new Set(); renderFix(); });
      const none = el("button", "quiet compact", "Select none");
      none.type = "button";
      none.addEventListener("click", () => { unchecked = new Set(items.map(item => item.id)); renderFix(); });
      toolbar.append(all, none);
      panel.append(toolbar);
      const listNode = el("ul", "names-changes names-suggestions");
      for (const item of items) {
        const segment = byId.get(item.segmentId);
        const row = el("li");
        const label = el("label", "names-suggestion");
        const box = el("input");
        box.type = "checkbox";
        box.checked = !unchecked.has(item.id);
        box.addEventListener("change", () => {
          if (box.checked) unchecked.delete(item.id); else unchecked.add(item.id);
          updateApply();
        });
        const text = el("span", "names-line");
        if (segment) text.append(inline(segment.text, item.before, item.after));
        else text.append(el("span", "muted", "(line deleted)"));
        label.append(box, text, el("span", "names-term", item.term));
        const stamp = el("button", "timestamp", segment ? hooks.time(segment.startMs) : "--:--:--");
        stamp.type = "button";
        stamp.disabled = !segment;
        if (segment) {
          stamp.setAttribute("aria-label", `Play from ${hooks.time(segment.startMs)}`);
          stamp.addEventListener("click", () => hooks.seekTime(segment.startMs));
        }
        row.append(stamp, label);
        listNode.append(row);
      }
      panel.append(listNode);
      const remember = el("label", "consent");
      const rememberBox = el("input");
      rememberBox.type = "checkbox";
      rememberBox.id = "names-remember";
      rememberBox.checked = true;
      remember.append(rememberBox, el("span", "", "Remember accepted spellings in my names list, so future transcripts are fixed automatically."));
      panel.append(remember);
    }
    const actions = el("div", "names-review-actions");
    const apply = el("button", "primary compact");
    apply.type = "button";
    apply.id = "names-apply-selected";
    const updateApply = () => {
      const count = items.filter(item => !unchecked.has(item.id)).length;
      apply.textContent = `Apply ${count} selected`;
      apply.disabled = !count || !editable();
    };
    apply.addEventListener("click", () => void run(async () => {
      const ids = items.filter(item => !unchecked.has(item.id)).map(item => item.id);
      const remember = $("names-remember")?.checked ?? false;
      const updated = await hooks.api(`/api/jobs/${job.id}/names/accept`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, remember }),
      });
      hooks.show(updated);
      hooks.message(`Applied ${ids.length} name fix${ids.length === 1 ? "" : "es"}.${updated.recap ? " Regenerate the recap to use them." : ""}`, "notice");
      if (remember) { listDirty = false; await loadList(); }
    }));
    const dismiss = el("button", "quiet compact", items.length ? "Dismiss all" : "OK");
    dismiss.type = "button";
    dismiss.disabled = !editable();
    dismiss.addEventListener("click", () => void run(async () => {
      hooks.show(await hooks.api(`/api/jobs/${job.id}/names/suggestions`, { method: "DELETE" }));
    }));
    if (items.length) { actions.append(apply); updateApply(); }
    actions.append(dismiss);
    panel.append(actions);
    root.append(panel);
  }

  async function run(work) {
    if (working) return;
    working = true;
    hooks.message("");
    renderFix();
    try { await work(); }
    catch (error) { hooks.message(error.message); }
    finally { working = false; renderFix(); renderList(); renderCorrections(); }
  }

  // ---- Corrections for the next recap ----
  function syncCorrections(force = false) {
    if (!job) return;
    if (force || !correctionsDirty || correctionsJob !== job.id) {
      corrections = (job.clarifications || []).map(item => ({ text: item.text, about: item.about || "" }));
      correctionsDirty = false;
      correctionsJob = job.id;
    }
  }

  function renderCorrections() {
    const section = $("recap-clarifications");
    if (!job || job.demo || (!job.recap && !corrections.length)) { section.hidden = true; return; }
    section.hidden = false;
    const root = $("clarification-rows");
    root.replaceChildren();
    const canEdit = hooks.canEdit() && !working;
    corrections.forEach((item, index) => {
      const row = el("div", "clarification-row");
      if (item.about) row.append(el("blockquote", "clarification-about", item.about));
      const input = el("textarea");
      input.rows = 2;
      input.maxLength = 500;
      input.value = item.text;
      input.disabled = !canEdit;
      input.placeholder = item.about ? "What actually happened, or the right name" : "e.g. The town she came from is Lostleton, not Lonelywood.";
      input.setAttribute("aria-label", item.about ? `Correction for: ${item.about}` : `Correction ${index + 1}`);
      input.addEventListener("input", () => { item.text = input.value; correctionsDirty = true; updateCorrectionControls(); });
      const remove = el("button", "quiet compact", "Remove");
      remove.type = "button";
      remove.disabled = !canEdit;
      remove.addEventListener("click", () => { corrections.splice(index, 1); correctionsDirty = true; renderCorrections(); });
      const controls = el("div", "clarification-row-controls");
      controls.append(input, remove);
      row.append(controls);
      root.append(row);
    });
    if (!corrections.length) root.append(el("p", "muted", "No corrections yet."));
    $("clarification-add").disabled = !canEdit || corrections.length >= 50;
    updateCorrectionControls();
  }

  function updateCorrectionControls() {
    $("clarification-save").disabled = !correctionsDirty || working || !hooks.canEdit() ||
      corrections.some(item => item.text.trim().length > 500);
    if (correctionsDirty) status("clarification-status", "Unsaved corrections");
    else if ($("clarification-status").textContent === "Unsaved corrections") status("clarification-status", "");
  }

  function addCorrection(about = "") {
    if (!job || job.demo) return;
    const existing = about ? corrections.findIndex(item => item.about === about) : -1;
    if (existing < 0) {
      corrections.push({ text: "", about });
      correctionsDirty = true;
    }
    renderCorrections();
    const index = existing < 0 ? corrections.length - 1 : existing;
    const target = $("clarification-rows").querySelectorAll("textarea")[index];
    target?.scrollIntoView({ behavior: "auto", block: "center" });
    target?.focus();
  }

  async function saveCorrections() {
    const clarifications = corrections.filter(item => item.text.trim())
      .map(item => ({ text: item.text.trim(), ...(item.about ? { about: item.about } : {}) }));
    const updated = await hooks.api(`/api/jobs/${job.id}/clarifications`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clarifications }),
    });
    correctionsDirty = false;
    syncCorrections(true);
    hooks.show(updated);
    status("clarification-status", updated.recap ? "Saved. Regenerate the recap to use them." : "Saved.");
  }

  function render(next) {
    const changed = next?.id !== job?.id;
    job = next;
    if (!hooks || !job) return;
    if (changed) { preview = null; correctionsDirty = false; }
    syncCorrections();
    if (!list && !listLoading) void loadList();
    renderFix();
    renderCorrections();
  }

  function reset(user) {
    job = null; list = null; rows = []; listDirty = false; preview = null; reviewKey = ""; unchecked = new Set();
    corrections = []; correctionsDirty = false; correctionsJob = "";
    $("names-rows").replaceChildren();
    $("names-result").replaceChildren();
    $("names-count").hidden = true;
    $("recap-clarifications").hidden = true;
    status("names-status", "");
    // The account can change before app.js calls init(); init() then loads the list itself.
    if (hooks && user?.status === "active") void loadList();
  }

  function init(appHooks) {
    hooks = appHooks;
    $("names-add").addEventListener("click", () => {
      rows.push({ term: "", variants: "" });
      markDirty();
      renderList();
      const inputs = $("names-rows").querySelectorAll(".names-row:last-child input");
      inputs[0]?.focus();
    });
    $("names-auto").addEventListener("change", markDirty);
    $("names-save").addEventListener("click", () => void run(saveList));
    $("names-preview").addEventListener("click", () => void run(async () => {
      await ensureSaved();
      const result = await hooks.api(`/api/jobs/${job.id}/names/preview`, { method: "POST" });
      preview = { jobId: job.id, ...result };
    }));
    $("names-suggest").addEventListener("click", () => void run(async () => {
      await ensureSaved();
      if (!list.entries.length) throw new Error("Add the correct spellings to your names list first.");
      await hooks.api(`/api/jobs/${job.id}/names/suggest`, { method: "POST" });
      await hooks.refresh();
    }));
    if (window.SessionScribeAuth?.getUser()?.status === "active" && !list) void loadList();
    $("clarification-add").addEventListener("click", () => addCorrection());
    $("clarification-save").addEventListener("click", () => void run(saveCorrections));
    window.addEventListener("beforeunload", event => {
      if (!listDirty && !correctionsDirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  window.SessionScribeNames = Object.freeze({ init, render, reset, clarify: addCorrection });
})();
