(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let invitationToken = "";
  let invitationEmail = "";
  let resetToken = "";
  let linkProblem = "";
  let intentVersion = 0;
  function captureFragmentIntent() {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (!fragment.has("invite") && !fragment.has("reset")) return false;
    const reset = fragment.has("reset");
    invitationToken = reset ? "" : fragment.get("invite") || "";
    invitationEmail = reset ? "" : fragment.get("email") || "";
    resetToken = reset ? fragment.get("reset") || "" : "";
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    linkProblem = !invitationToken && !resetToken ?
      "This one-use link is incomplete. Ask the administrator for a new link." : "";
    ++intentVersion;
    return true;
  }
  captureFragmentIntent();
  let user = null;
  let csrfToken = null;
  let loaded = false;
  let setupRequired = false;
  let loadError = "";
  let stateVersion = 0;
  let refreshVersion = 0;
  let adminVersion = 0;
  let signOutGuard = () => true;
  let signingOut = false;
  let decision = null;
  let decisionBusy = false;
  let issuingLink = false;
  let activeLink = "";
  let syncInFlight = null;
  let syncQueued = false;
  let peerChangePending = false;
  let lastSync = 0;
  let authChannel = null;
  try {
    if (typeof BroadcastChannel === "function") authChannel = new BroadcastChannel("session-scribe-auth");
  } catch { /* Focus and visibility checks remain available without BroadcastChannel. */ }
  const subscribers = new Set();
  const publicEndpoints = new Set([
    "/api/auth/session", "/api/auth/login", "/api/auth/register", "/api/auth/reset",
  ]);
  const unsafe = method => !["GET", "HEAD", "OPTIONS"].includes(method);

  function text(id, value) {
    $(id).textContent = value || "";
    $(id).hidden = !value;
  }

  function safeUser(value) {
    if (!value || !["admin", "user"].includes(value.role) ||
        !["pending", "active", "rejected", "suspended"].includes(value.status)) return null;
    return Object.freeze({
      id: value.id, email: String(value.email), role: value.role, status: value.status,
      createdAt: value.createdAt,
      verificationMethod: ["invitation", "manual"].includes(value.verificationMethod) ?
        value.verificationMethod : null,
      consentAccepted: value.consentAccepted === true,
    });
  }

  function canAccessWorkspace() {
    return loaded && user?.status === "active" && !setupRequired && !loadError &&
      !invitationToken && !resetToken && !linkProblem;
  }

  function notify() {
    for (const handler of subscribers) handler(user);
  }

  function sameIdentity(identity) {
    if (!identity || !user) return identity === null && user === null;
    return identity.id === user.id && identity.role === user.role && identity.status === user.status;
  }

  function announceAuthChange(type = "auth-state") {
    if (!authChannel) return;
    try {
      authChannel.postMessage(type === "auth-state" ? {
        type, identity: user ? { id: user.id, role: user.role, status: user.status } : null,
      } : { type });
    } catch { /* No storage fallback: messages never contain credentials or session tokens. */ }
  }

  function clearIssuedLink() {
    activeLink = "";
    $("issued-link-value").value = "";
    $("issued-link-expiry").textContent = "";
    $("issued-token-value").value = "";
    $("issued-token-label").hidden = true;
    $("issued-link-status").textContent = "";
    $("copy-issued-link").disabled = false;
    if ($("issued-link-dialog").open) $("issued-link-dialog").close();
  }

  function clearAdminData() {
    ++adminVersion;
    $("admin-users-body").replaceChildren();
    $("admin-whitelist-body").replaceChildren();
    $("whitelist-email").value = "";
    text("admin-message", "");
    text("admin-error", "");
    decision = null;
    $("admin-confirm-identity").checked = false;
    if ($("admin-decision-dialog").open) $("admin-decision-dialog").close();
    clearIssuedLink();
  }

  function renderAccount(previous) {
    const active = canAccessWorkspace();
    const linkFlow = Boolean(invitationToken || resetToken || linkProblem);
    if (previous?.id !== user?.id || previous?.role === "admin" && user?.role !== "admin") clearAdminData();
    document.body.classList.toggle("authenticated", active);
    document.querySelectorAll("[data-workspace-only]").forEach(node => { node.hidden = !active; });
    $("account-summary").hidden = !user;
    $("account-email").textContent = user?.email || "";
    $("admin-nav").hidden = !active || user?.role !== "admin";
    $("auth-view").hidden = active || Boolean(user && !loadError && !linkFlow && !setupRequired);
    $("access-view").hidden = !user || active || Boolean(loadError) || linkFlow || setupRequired;
    $("auth-loading").hidden = loaded;
    $("auth-load-error").hidden = !loadError;
    text("auth-load-error-text", loadError);
    $("auth-setup").hidden = !loaded || !setupRequired || Boolean(loadError);
    $("auth-forms").hidden = !loaded || setupRequired || Boolean(loadError);
    $("auth-link-actions").hidden = !linkFlow;
    text("auth-existing-session", user && linkFlow ?
      `You are signed in as ${user.email}. Sign out before accepting this one-use link. The link stays in memory until you leave this page or cancel it.` : "");
    for (const id of ["login-form", "signup-form", "reset-form"]) {
      $(id).querySelectorAll("input, button").forEach(control => {
        control.disabled = Boolean(user && linkFlow) ||
          control.tagName === "BUTTON" && $(id).getAttribute("aria-busy") === "true";
      });
    }
    if (!active) {
      $("library-view").hidden = true;
      $("session-panel").hidden = true;
      $("admin-view").hidden = true;
      $("admin-nav").classList.remove("active");
      $("admin-nav").removeAttribute("aria-current");
      window.SessionScribeUI.closeImport();
      clearAdminData();
      if (user && !linkFlow) {
        const status = {
          pending: ["Access pending", "Talk to the admin to enable access",
            "Your account is waiting for administrator approval. Refresh after the administrator confirms your identity and enables access."],
          rejected: ["Account request rejected", "This account does not have workspace access.",
            "Talk to the administrator if you believe this decision is incorrect."],
          suspended: ["Account access suspended", "Your workspace access has been suspended.",
            "Talk to the administrator before continuing. Your recordings are not accessible while access is suspended."],
        }[user.status];
        $("access-heading").textContent = status?.[0] || "Access unavailable";
        $("access-description").textContent = status?.[1] || "Talk to the admin to enable access";
        $("access-detail").textContent = status?.[2] || "";
      }
    } else if (previous?.id !== user.id || previous?.status !== "active" || previous?.role !== user.role ||
        (!$("auth-view").hidden || $("library-view").hidden && $("session-panel").hidden && $("admin-view").hidden)) {
      window.SessionScribeUI.showLibrary();
    }
    if (active && user.role !== "admin" && !$("admin-view").hidden) {
      clearAdminData();
      window.SessionScribeUI.showLibrary();
    }
  }

  function renderSignupMode(open) {
    $("signup-tab").textContent = open ? "Request an account" : "Use an invitation";
    $("signup-submit").textContent = open ? "Create account / request access" : "Create account";
    const optional = $("invitation-field").querySelector(".optional");
    if (optional) optional.hidden = !open;
    $("signup-hint").textContent = open ?
      "Anyone may request an account. Ordinary signups stay pending until the administrator personally confirms identity and approves access. A valid invitation activates only its bound, whitelisted email." :
      "Accounts are by invitation only. Open the one-use invitation link the administrator shared with you, or enter your email and paste the invitation token below.";
  }

  function applySession(data, error = "") {
    const previous = user;
    user = safeUser(data?.user);
    csrfToken = typeof data?.csrfToken === "string" ? data.csrfToken : null;
    setupRequired = Boolean(data?.setupRequired);
    if (typeof data?.openSignup === "boolean") renderSignupMode(data.openSignup);
    loadError = error;
    loaded = true;
    ++stateVersion;
    renderAccount(previous);
    notify();
  }

  async function request(url, options = {}) {
    const target = new URL(url, window.location.origin);
    if (target.origin !== window.location.origin || target.username || target.password) {
      throw new Error("Requests must stay on this app's origin.");
    }
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers);
    if (unsafe(method) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
    const protectedRequest = !publicEndpoints.has(target.pathname);
    const version = stateVersion;
    const response = await fetch(target.href, {
      ...options, method, headers, credentials: "same-origin", redirect: "error",
    });
    let data = null;
    if (response.status !== 204) {
      try { data = await response.json(); }
      catch {
        if (response.ok) throw new Error("The server returned an unreadable response. Try again.");
      }
    }
    if (!response.ok) {
      const error = new Error(typeof data?.error === "string" ? data.error :
        typeof data?.message === "string" ? data.message : `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = typeof data?.code === "string" ? data.code : "";
      if (protectedRequest && version === stateVersion) {
        if (response.status === 401) {
          ++refreshVersion;
          applySession({ user: null, csrfToken: null, setupRequired: false });
          text("auth-message", "Your session ended. Sign in again to continue.");
        } else if (response.status === 403) {
          try { await refresh(); } catch { /* The access-check error is displayed by refresh. */ }
        }
      }
      throw error;
    }
    return data;
  }

  const json = (url, method, value) => request(url, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  });

  async function refresh({ background = false } = {}) {
    const version = ++refreshVersion;
    try {
      const data = await request("/api/auth/session");
      if (version === refreshVersion) {
        text("auth-sync-warning", "");
        applySession(data);
        if (peerChangePending) {
          peerChangePending = false;
          text("auth-message", user ? "" : "Your account session changed. Sign in to continue.");
        }
      }
      return user;
    } catch (error) {
      if (version === refreshVersion) {
        if (background && user) {
          text("auth-sync-warning", "Unable to recheck account access. Your unsaved work is kept; reconnect and refresh access before continuing.");
        } else {
          applySession({ user: null, csrfToken: null }, "Unable to check your account. Check your connection and try again.");
        }
      }
      throw error;
    }
  }

  function syncSession(force = false) {
    if (syncInFlight) {
      if (force) syncQueued = true;
      return syncInFlight;
    }
    if (!force && (document.visibilityState === "hidden" || Date.now() - lastSync < 1500)) return;
    lastSync = Date.now();
    syncInFlight = refresh({ background: true }).catch(() => {}).finally(() => {
      syncInFlight = null;
      if (syncQueued) {
        syncQueued = false;
        syncSession(true);
      }
    });
    return syncInFlight;
  }

  window.SessionScribeAuth = Object.freeze({
    request,
    onChange(handler) {
      if (typeof handler !== "function") throw new TypeError("An account-change handler is required.");
      subscribers.add(handler);
      if (loaded) handler(user);
      return () => subscribers.delete(handler);
    },
    getUser: () => user,
    // For upload requests that need XMLHttpRequest (byte-level progress) instead of fetch.
    getCsrfToken: () => csrfToken,
    canAccessWorkspace,
    guardSignOut(handler) {
      if (typeof handler !== "function") throw new TypeError("A sign-out guard is required.");
      signOutGuard = handler;
    },
    refresh,
  });

  function selectAuthPanel(name, focus = false) {
    const reset = name === "reset";
    $("auth-tabs").hidden = reset || Boolean(invitationToken);
    for (const panel of ["login", "signup", "reset"]) {
      $(`${panel}-panel`).hidden = panel !== name;
      const tab = $(`${panel}-tab`);
      if (!tab) continue;
      tab.classList.toggle("active", panel === name);
      tab.setAttribute("aria-selected", String(panel === name));
      tab.tabIndex = panel === name ? 0 : -1;
      if (panel === name && focus) tab.focus();
    }
  }
  const authTabs = [...document.querySelectorAll("[data-auth-tab]")];
  authTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectAuthPanel(tab.dataset.authTab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? authTabs.length - 1 : 1 - index;
      selectAuthPanel(authTabs[next].dataset.authTab, true);
    });
  });

  function setFormBusy(form, busy) {
    form.setAttribute("aria-busy", String(busy));
    form.querySelectorAll("button[type=submit]").forEach(button => {
      button.disabled = busy || Boolean(user && (invitationToken || resetToken || linkProblem));
    });
  }

  function clearCredentials() {
    for (const id of ["login-password", "signup-password", "signup-invitation", "reset-password", "reset-confirm"]) {
      $(id).value = "";
    }
  }

  function showLinkProblem(message) {
    linkProblem = message;
    invitationToken = "";
    resetToken = "";
    invitationEmail = "";
    $("signup-email").readOnly = false;
    $("invitation-field").hidden = false;
    $("invitation-notice").hidden = true;
    $("auth-link-error").hidden = false;
    $("auth-link-error-text").textContent = message;
    $("reset-panel").hidden = true;
    $("auth-tabs").hidden = false;
    selectAuthPanel("login");
  }

  function linkError(error) {
    return /expired|invalid|used|redeemed/i.test(`${error.code} ${error.message}`) &&
      /link|token|invitation|expired|redeemed/i.test(`${error.code} ${error.message}`);
  }

  function cancelIncomingLink() {
    ++intentVersion;
    invitationToken = "";
    resetToken = "";
    invitationEmail = "";
    clearCredentials();
    $("signup-email").readOnly = false;
    $("invitation-field").hidden = false;
    $("invitation-notice").hidden = true;
    $("auth-link-error").hidden = true;
    linkProblem = "";
    selectAuthPanel("login");
    applySession({ user, csrfToken, setupRequired });
    if (!user) $("login-email").focus();
  }
  $("auth-return-login").addEventListener("click", cancelIncomingLink);
  $("auth-cancel-link").addEventListener("click", cancelIncomingLink);

  $("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (user && (invitationToken || resetToken || linkProblem)) return;
    if (form.getAttribute("aria-busy") === "true") return;
    setFormBusy(form, true);
    text("login-error", "");
    text("auth-message", "");
    try {
      const data = await json("/api/auth/login", "POST", {
        email: $("login-email").value.trim(), password: $("login-password").value,
      });
      ++refreshVersion;
      applySession(data);
      announceAuthChange();
    } catch (error) {
      text("login-error", error.message);
    } finally {
      $("login-password").value = "";
      setFormBusy(form, false);
    }
  });

  $("signup-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (user && (invitationToken || resetToken || linkProblem)) return;
    if (form.getAttribute("aria-busy") === "true") return;
    setFormBusy(form, true);
    text("signup-error", "");
    text("auth-message", "");
    const token = invitationToken || $("signup-invitation").value.trim();
    const submittedIntent = intentVersion;
    try {
      const data = await json("/api/auth/register", "POST", {
        email: $("signup-email").value.trim(), password: $("signup-password").value,
        ...(token ? { invitationToken: token } : {}),
        ...($("signup-consent").checked ? { recordingConsent: true } : {}),
        ...($("signup-consent").checked ? { recordingConsent: true } : {}),
      });
      if (submittedIntent === intentVersion) {
        invitationToken = "";
        invitationEmail = "";
        $("signup-email").readOnly = false;
        $("invitation-field").hidden = false;
        $("invitation-notice").hidden = true;
      }
      if (data?.user) {
        ++refreshVersion;
        applySession(data);
        announceAuthChange();
      } else if (submittedIntent === intentVersion) {
        text("auth-message", data?.message || "If this request can be processed, your account will await administrator approval. Sign in to check access.");
        $("login-email").value = $("signup-email").value.trim();
        selectAuthPanel("login");
      }
    } catch (error) {
      if (submittedIntent === intentVersion) {
        text("signup-error", error.message);
        if (token && linkError(error)) showLinkProblem(error.message);
      }
    } finally {
      if (submittedIntent === intentVersion) {
        $("signup-password").value = "";
        $("signup-invitation").value = "";
      }
      setFormBusy(form, false);
    }
  });

  $("reset-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (user && (invitationToken || resetToken || linkProblem)) return;
    if (form.getAttribute("aria-busy") === "true") return;
    text("reset-error", "");
    if (!resetToken) return showLinkProblem("A valid administrator-issued reset link is required.");
    if ($("reset-password").value !== $("reset-confirm").value) {
      text("reset-error", "The new passwords do not match.");
      $("reset-confirm").focus();
      return;
    }
    setFormBusy(form, true);
    const submittedIntent = intentVersion;
    const submittedToken = resetToken;
    try {
      const data = await json("/api/auth/reset", "POST", {
        token: submittedToken, password: $("reset-password").value,
      });
      if (submittedIntent === intentVersion) resetToken = "";
      ++refreshVersion;
      applySession({ user: null, csrfToken: null });
      announceAuthChange();
      if (submittedIntent === intentVersion) {
        selectAuthPanel("login");
        text("auth-message", data?.message || "Password reset. Sign in with your new password.");
      }
    } catch (error) {
      if (submittedIntent === intentVersion) {
        text("reset-error", error.message);
        if (linkError(error)) showLinkProblem(error.message);
      }
    } finally {
      if (submittedIntent === intentVersion) {
        $("reset-password").value = "";
        $("reset-confirm").value = "";
      }
      setFormBusy(form, false);
    }
  });

  async function signOut() {
    if (signingOut || !user) return;
    signingOut = true;
    text("account-error", "");
    document.querySelectorAll("[data-signout]").forEach(button => { button.disabled = true; });
    try {
      if (!await signOutGuard()) return;
      await json("/api/auth/logout", "POST", {});
      ++refreshVersion;
      clearCredentials();
      applySession({ user: null, csrfToken: null });
      announceAuthChange();
      selectAuthPanel(resetToken ? "reset" : invitationToken ? "signup" : "login");
      text("auth-message", "Signed out.");
    } catch (error) {
      if (user) text("account-error", error.message);
    } finally {
      signingOut = false;
      document.querySelectorAll("[data-signout]").forEach(button => { button.disabled = false; });
    }
  }
  document.querySelectorAll("[data-signout]").forEach(button => button.addEventListener("click", signOut));
  document.querySelectorAll("[data-refresh-auth]").forEach(button => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      text("access-error", "");
      try { await refresh(); } catch { /* The access-check error is visible in auth-view. */ }
      finally { button.disabled = false; }
    });
  });

  function node(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function action(label, handler, className = "quiet") {
    const button = node("button", label, className);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      text("admin-error", "");
      try { await handler(); }
      catch (error) { text("admin-error", error.message); }
      finally { button.disabled = false; }
    });
    return button;
  }

  function date(value) {
    const result = new Date(value);
    return Number.isNaN(result.getTime()) ? "Not recorded" : result.toLocaleDateString();
  }

  function beginDecision(account, status) {
    if (account.role === "admin" || account.id === user?.id) return;
    decision = { id: account.id, email: account.email, status };
    const active = status === "active";
    $("admin-decision-title").textContent = active ? "Approve account access?" :
      status === "rejected" ? "Reject this account request?" : "Suspend account access?";
    $("admin-decision-description").textContent = active ?
      `Enable workspace access for ${account.email}. Only approve after personally confirming their identity and email ownership.` :
      `${account.email} will not be able to access their workspace. This does not delete their recordings.`;
    $("admin-identity-label").hidden = !active;
    $("admin-confirm-identity").checked = false;
    $("admin-confirm-identity").required = active;
    $("admin-decision-submit").textContent = active ? "Approve access" :
      status === "rejected" ? "Reject request" : "Suspend access";
    $("admin-decision-submit").disabled = active;
    text("admin-decision-error", "");
    $("admin-decision-dialog").showModal();
  }

  function displayIssuedLink(data, title) {
    if (!canAccessWorkspace() || user?.role !== "admin") return;
    clearIssuedLink();
    if (typeof data?.url !== "string" || !data.url) throw new Error("The server did not return a link.");
    activeLink = data.url;
    $("issued-link-title").textContent = title;
    $("issued-link-value").value = activeLink;
    if (typeof data.token === "string" && data.token) {
      $("issued-token-value").value = data.token;
      $("issued-token-label").hidden = false;
    }
    const expires = new Date(data.expiresAt);
    $("issued-link-expiry").textContent = Number.isNaN(expires.getTime()) ?
      "One use only. Ask the server operator if the expiry is unavailable." :
      `One use only · expires ${expires.toLocaleString()}`;
    $("issued-link-dialog").showModal();
    $("issued-link-value").focus();
    $("issued-link-value").select();
  }

  async function issueLink(url, payload, title) {
    if (issuingLink) throw new Error("Another link is being issued. Wait for its result before creating another.");
    issuingLink = true;
    try {
      const data = await json(url, "POST", payload);
      displayIssuedLink(data, title);
    } finally { issuingLink = false; }
  }

  function renderUsers(users) {
    $("admin-users-body").replaceChildren();
    $("admin-users-empty").hidden = users.length > 0;
    const ordered = [...users].sort((left, right) =>
      Number(right.status === "pending") - Number(left.status === "pending") ||
      String(left.createdAt).localeCompare(String(right.createdAt)));
    for (const account of ordered) {
      const row = node("tr");
      const emailCell = node("td");
      emailCell.append(node("strong", account.email), node("span", account.role, "table-detail"));
      const verification = account.verificationMethod === "invitation" ? "Invitation accepted" :
        account.verificationMethod === "manual" ? "Identity confirmed manually" : "Not confirmed";
      const controls = node("div", undefined, "admin-row-actions");
      if (account.role === "admin" || account.id === user?.id) controls.append(node("span", "Protected account", "hint"));
      else {
        if (account.status !== "active") controls.append(action("Approve", () => beginDecision(account, "active"), "secondary compact"));
        if (account.status === "pending") controls.append(action("Reject", () => beginDecision(account, "rejected"), "quiet danger"));
        if (account.status === "active") controls.append(action("Suspend", () => beginDecision(account, "suspended"), "quiet danger"));
        controls.append(action("Issue reset link", () => issueLink(
          `/api/admin/users/${encodeURIComponent(account.id)}/reset-link`, {}, `Reset link for ${account.email}`)));
      }
      const actionCell = node("td");
      actionCell.append(controls);
      row.append(emailCell, node("td", date(account.createdAt)), node("td", verification),
        node("td", account.status), actionCell);
      $("admin-users-body").append(row);
    }
  }

  function renderWhitelist(entries) {
    $("admin-whitelist-body").replaceChildren();
    $("admin-whitelist-empty").hidden = entries.length > 0;
    for (const entry of entries) {
      const row = node("tr");
      const controls = node("div", undefined, "admin-row-actions");
      controls.append(action("Create invitation", () => issueLink(
        "/api/admin/invitations", { email: entry.email }, `Invitation for ${entry.email}`),
      "secondary compact"), action("Remove", async () => {
        if (!window.confirm(`Remove ${entry.email} from the email whitelist? Existing account access is unchanged.`)) return;
        await json(`/api/admin/whitelist/${encodeURIComponent(entry.email)}`, "DELETE", {});
        text("admin-message", "Email removed from the whitelist.");
        await loadAdmin();
      }, "quiet danger"));
      const actionCell = node("td");
      actionCell.append(controls);
      row.append(node("td", entry.email), node("td", date(entry.createdAt)), actionCell);
      $("admin-whitelist-body").append(row);
    }
  }

  async function loadAdmin() {
    if (!canAccessWorkspace() || user?.role !== "admin") return;
    const version = ++adminVersion;
    $("admin-loading").hidden = false;
    $("admin-refresh").disabled = true;
    text("admin-error", "");
    try {
      const [accounts, whitelist] = await Promise.all([
        request("/api/admin/users"), request("/api/admin/whitelist"),
      ]);
      if (version !== adminVersion || !canAccessWorkspace() || user?.role !== "admin") return;
      renderUsers(accounts.users || []);
      renderWhitelist(whitelist.entries || []);
    } catch (error) {
      if (version === adminVersion) text("admin-error", error.message);
    } finally {
      if (version === adminVersion) {
        $("admin-loading").hidden = true;
        $("admin-refresh").disabled = false;
      }
    }
  }

  $("admin-nav").addEventListener("click", () => {
    if (window.SessionScribeUI.showAdmin()) loadAdmin();
  });
  $("admin-refresh").addEventListener("click", loadAdmin);
  $("create-open-invitation").addEventListener("click", async () => {
    text("admin-error", "");
    try { await issueLink("/api/admin/open-invitations", {}, "Open invitation (any email)"); }
    catch (error) { text("admin-error", error.message); }
  });
  $("revoke-open-invitations").addEventListener("click", async () => {
    if (!window.confirm("Revoke every unused open invitation? People who already signed up keep their accounts.")) return;
    text("admin-error", "");
    try {
      const result = await json("/api/admin/open-invitations/revoke", "POST", {});
      text("admin-message", `${result.revoked} unused open invitation${result.revoked === 1 ? "" : "s"} revoked.`);
    } catch (error) { text("admin-error", error.message); }
  });
  $("whitelist-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.getAttribute("aria-busy") === "true") return;
    setFormBusy(form, true);
    text("admin-error", "");
    text("admin-message", "");
    try {
      await json("/api/admin/whitelist", "POST", { email: $("whitelist-email").value.trim() });
      $("whitelist-email").value = "";
      text("admin-message", "Email whitelisted. Share a one-use invitation personally to enable access.");
      await loadAdmin();
    } catch (error) { text("admin-error", error.message); }
    finally { setFormBusy(form, false); }
  });
  $("admin-confirm-identity").addEventListener("change", () => {
    $("admin-decision-submit").disabled = decisionBusy ||
      (decision?.status === "active" && !$("admin-confirm-identity").checked);
  });
  function closeDecision() {
    if (decisionBusy) return;
    if ($("admin-decision-dialog").open) $("admin-decision-dialog").close();
  }
  document.querySelectorAll("[data-close-decision]").forEach(button => button.addEventListener("click", closeDecision));
  $("admin-decision-dialog").addEventListener("cancel", event => {
    if (decisionBusy) event.preventDefault();
  });
  $("admin-decision-dialog").addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeDecision();
  });
  $("admin-decision-dialog").addEventListener("close", () => {
    if ($("admin-decision-dialog").open) return;
    decision = null;
    $("admin-confirm-identity").checked = false;
    text("admin-decision-error", "");
  });
  $("admin-decision-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!decision || decisionBusy || !canAccessWorkspace() || user?.role !== "admin") return;
    if (decision.status === "active" && !$("admin-confirm-identity").checked) return;
    const selected = decision;
    decisionBusy = true;
    $("admin-decision-submit").disabled = true;
    document.querySelectorAll("[data-close-decision]").forEach(button => { button.disabled = true; });
    text("admin-decision-error", "");
    try {
      await json(`/api/admin/users/${encodeURIComponent(selected.id)}`, "PATCH", {
        status: selected.status, ...(selected.status === "active" ? { confirmedIdentity: true } : {}),
      });
      announceAuthChange("access-changed");
      $("admin-decision-dialog").close();
      text("admin-message", `Account access updated for ${selected.email}.`);
      await loadAdmin();
    } catch (error) { text("admin-decision-error", error.message); }
    finally {
      decisionBusy = false;
      $("admin-decision-submit").disabled = decision?.status === "active" && !$("admin-confirm-identity").checked;
      document.querySelectorAll("[data-close-decision]").forEach(button => { button.disabled = false; });
    }
  });

  document.querySelectorAll("[data-close-issued-link]").forEach(button => button.addEventListener("click", clearIssuedLink));
  $("issued-link-dialog").addEventListener("close", () => {
    if (!$("issued-link-dialog").open) clearIssuedLink();
  });
  $("issued-link-dialog").addEventListener("cancel", event => {
    event.preventDefault();
    clearIssuedLink();
  });
  $("issued-link-dialog").addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    clearIssuedLink();
  });
  $("copy-issued-link").addEventListener("click", async () => {
    if (!activeLink) return;
    const link = activeLink;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link);
      if (activeLink === link) {
        $("issued-link-status").textContent = "Copied. Share personally with the intended recipient.";
        $("copy-issued-link").disabled = true;
      }
    } catch {
      if (activeLink !== link) return;
      $("issued-link-status").textContent = "Clipboard copy failed. Select the link above and copy it manually before closing.";
      $("issued-link-value").focus();
      $("issued-link-value").select();
    }
  });

  authChannel?.addEventListener("message", event => {
    const message = event.data;
    if (!message || !["auth-state", "access-changed"].includes(message.type)) return;
    if (message.type === "auth-state") {
      const identity = message.identity;
      if (identity !== null && (!identity || !["string", "number"].includes(typeof identity.id) ||
          !["admin", "user"].includes(identity.role) ||
          !["pending", "active", "rejected", "suspended"].includes(identity.status))) return;
      ++refreshVersion;
      ++stateVersion;
      if (!sameIdentity(identity)) {
        peerChangePending = true;
        applySession({ user: null, csrfToken: null });
        text("auth-message", "Account access changed in another tab. Checking your current session…");
      }
    } else {
      ++refreshVersion;
      ++stateVersion;
    }
    syncSession(true);
  });
  window.addEventListener("focus", () => syncSession());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncSession();
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) syncSession(true);
  });

  function showFragmentIntent() {
    clearCredentials();
    for (const id of ["login-error", "signup-error", "reset-error", "auth-message"]) text(id, "");
    $("auth-link-error").hidden = true;
    $("signup-email").readOnly = false;
    $("invitation-field").hidden = false;
    text("invitation-notice", "");
    if (linkProblem) showLinkProblem(linkProblem);
    else if (resetToken) selectAuthPanel("reset");
    else if (invitationToken) {
      selectAuthPanel("signup");
      $("signup-email").value = invitationEmail;
      $("signup-email").readOnly = Boolean(invitationEmail);
      $("invitation-field").hidden = true;
      text("invitation-notice", invitationEmail ?
        `Invitation for ${invitationEmail}. Create a password to accept this one-use invitation.` :
        "You've been invited. Enter the email you want to sign in with and create a password to accept this one-use invitation.");
    }
    if (loaded) renderAccount(user);
  }
  window.addEventListener("hashchange", () => {
    if (captureFragmentIntent()) showFragmentIntent();
  });
  showFragmentIntent();
  refresh().catch(() => {});
})();
