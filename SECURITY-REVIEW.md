# Security Review — Session Scribe

**Date:** 2026-10-02
**Scope:** Full, read-only review of the whole codebase, its git history, the `infra/` deployment files, and the dependencies.
**Goal:** Publish the source on GitHub, and later host the app in Azure, without letting outsiders get past the email allowlist or run up the Azure bill.

> This file deliberately leaves out the real Azure IDs, hostnames and email addresses it talks about. It's safe to publish once the fixes below are done.

---

## 1. Summary

| # | Severity | Area | Issue | Blocks |
|---|----------|------|-------|--------|
| 1 | ⚪ LOW | `infra/`, `README.md`, `PLAN.md` | Live Azure resource names and IDs appear in tracked files and in every past commit | Publishing on GitHub |
| 2 | ⚪ LOW | Git metadata | Personal author email on every commit; `refs/agents/*` checkpoint refs | Publishing on GitHub |
| 3 | 🟡 MEDIUM (once hosted) | `src/accounts.ts` `rate()` | Per-IP rate limit sees one shared IP behind App Service, so anyone can lock everyone out of sign-in | Hosting in Azure |
| 4 | ⚪ LOW (once hosted) | `src/accounts.ts` `rate()` | Per-email limit lets an attacker lock out a specific user | Hosting in Azure |
| 5 | Info | `src/app.ts`, `src/accounts.ts` | Localhost-only protections must be swapped for production equivalents, not just removed | Hosting in Azure |
| 6 | Info | Cost controls | No per-user daily or monthly usage limits | Hosting in Azure |

No critical or high issues were found. No credentials, keys or tokens were found in any file, commit or ref.

---

## 2. Findings that block publishing on GitHub

### Finding 1 — Live Azure resource names and IDs in tracked files (LOW, confidence 9/10)

**Where:**
- `infra/deploy-gateway.ps1` (lines ~2-4: default subscription, resource group, app name)
- `infra/gateway-api.json` (lines ~2, 11)
- `infra/gateway-role-assignment.json` (lines ~2-4)
- `README.md` (lines ~113, 116, 161, 165-177)
- `PLAN.md` (lines ~72-77)

**What's exposed:**
- the subscription ID and resource group names
- the gateway App Service hostname and the shared App Service plan name and its resource group
- the Speech and OpenAI endpoint hostnames
- these app registration and role IDs:
  - the gateway API app
  - its service principal
  - the `Audio.Manage` app role
  - the local app's client ID and object ID
- the gateway managed identity ID
- the VNet, subnet and private-endpoint address layout
- a real job ID

**Risk:** None of these values gives access by itself. The gateway checks tokens strictly (see §4). Storage is locked down by its network perimeter, with anonymous and shared-key access turned off. The tenant ID and storage account name are **not** in any tracked file or commit. Even so, the names give an attacker a map for probing. In particular, they could try API-key calls against the Speech and OpenAI resources if key-based access is still turned on there.

**Fix:**
1. Replace every real value with a placeholder, for example `<subscription-id>`, `<resource-group>`, `<gateway-app-name>`, `<speech-endpoint>`, `<openai-endpoint>`, `<client-app-id>`, `<gateway-api-app-id>` and `<app-role-id>`.
2. In `infra/deploy-gateway.ps1`, make subscription, resource group and app name **required parameters** (or read them from environment variables) with no real defaults.
3. Turn `infra/gateway-api.json` and `infra/gateway-role-assignment.json` into templates such as `*.template.json` with placeholders. Generate the real files locally and add them to `.gitignore`, or build the JSON at deploy time inside the script.
4. In `README.md` and `PLAN.md`, describe the architecture in generic terms: "a private-endpoint storage account", "an App Service gateway", and so on.
5. In Azure, confirm `disableLocalAuth = true` on the Speech and OpenAI resources so only Entra ID can call them. If key access was ever on, rotate both keys.
6. Because the values are in **every past commit**, editing the files isn't enough. See Finding 2.

### Finding 2 — Personal email and agent refs in git metadata (LOW, confidence 9/10)

**Where:**
- every commit is authored with a personal email address
- 9 checkpoint refs exist under `refs/agents/*`, left by AI coding sessions

**Risk:**
- Pushing the current history publishes your personal email, plus every past version of the files from Finding 1.
- `git push --mirror` or `--all` would also publish the `refs/agents/*` refs. They hold only source code (no secrets found), but they're noise.

**Fix (publish from a clean history):**
```powershell
git config user.email "<id>+<username>@users.noreply.github.com"
git checkout --orphan public
git add -A
git status --ignored   # confirm .env, .secrets/, data/ show as ignored (!!)
git commit -m "Initial public release"
git ls-tree -r --name-only HEAD   # confirm no do-not-push files (see §5)
git push <github-remote> public:main   # push ONLY this branch; never --mirror or --all
```
Also turn on **"Block command line pushes that expose my email"** in your GitHub email settings.

---

## 3. Findings to fix before hosting in Azure

Right now the app only accepts localhost requests (`src/app.ts` ~line 37). The plan is to move it into the App Service that currently runs the storage gateway. The items below are not exploitable today, but they become real once the app is reachable from the internet.

### Finding 3 — Rate limiting collapses to one shared IP behind App Service (MEDIUM once hosted, confidence 8/10)

**Where:** `src/accounts.ts`, `rate()` (~lines 208-227). The per-IP key uses `req.ip ?? req.socket.remoteAddress`, and Express `trust proxy` is not set.

**Risk:** Inside App Service, every request arrives through Azure's front-end load balancers. With `trust proxy` off, `req.ip` is the load balancer's address, not the user's. The per-IP limit therefore becomes **one global limit**: 40 sign-ins, 20 registrations or 30 resets per window, shared by everyone. One anonymous attacker sending about 40 bad sign-ins every 15 minutes would lock **all** users, including you, out of signing in. (Ignoring `X-Forwarded-For` is correct for localhost, but it's wrong behind a trusted proxy.)

**Fix:**
- When hosted, set `app.set("trust proxy", 1)`. Use the exact number of trusted hops, never `true`.
  - App Service alone adds one hop.
  - If you put Front Door or Application Gateway in front, count those too, and restrict App Service to accept traffic only from that front door (access restrictions using the `AzureFrontDoor.Backend` service tag plus the `X-Azure-FDID` header check).
- Keep localhost mode ignoring forwarded headers. Make this an explicit config switch, such as `TRUST_PROXY_HOPS`, defaulting to 0.
- Consider adding a global safety ceiling, and alert when it trips.

### Finding 4 — Targeted account lockout via the per-email limit (LOW once hosted, confidence 7/10)

**Where:** `src/accounts.ts`, `rate()`. Sign-in allows 12 attempts per email per 15 minutes, counting failed **and** successful attempts, keyed only by email.

**Risk:** Anyone who knows a player's email can spend those 12 attempts with wrong passwords every 15 minutes and keep that player locked out. Locally the impact is nil.

**Fix (choose one or more):**
- Count only **failed** attempts toward the per-email limit, and reset the counter on success.
- Key the email limit by email + IP, and keep a looser email-only limit.
- Add a CAPTCHA or proof-of-work challenge after N failures, instead of a hard block.
- Optional: let users who are already signed in keep their sessions; only new sign-ins are limited (this is already the case).

### Finding 5 — Replace the localhost protections for production; don't just remove them (Info)

The current Host-header check and cookie settings are written for localhost. When you host the app:

| Today (localhost) | Production equivalent |
|---|---|
| Host must be `localhost`/`127.0.0.1`/`[::1]` (`src/app.ts` ~37; `src/accounts.ts` `loopback()` ~103) | Host must **exactly** equal your configured public hostname or hostnames, set via config such as `PUBLIC_ORIGIN`. Reject everything else, including `*.azurewebsites.net` if you use a custom domain behind Front Door. |
| `requestOrigin()` falls back to the Host header when no origin is configured | **Require** a configured `PUBLIC_ORIGIN` in production and fail to start without it. Never build the origin from the Host header for invite or reset links (that would allow host-header poisoning of reset emails). |
| Cookie `secure` is only set when the origin is `https:` (`src/accounts.ts` ~124) | Always `Secure` in production, and consider the `__Host-` cookie prefix. Turn on App Service **HTTPS Only** and minimum TLS 1.2. |
| No HSTS needed | Send `Strict-Transport-Security: max-age=31536000; includeSubDomains`. |
| The first admin is created by local `users:bootstrap` | Keep it CLI-only. Run it via SSH/Kudu or a one-off job, never from an HTTP endpoint. Make sure "setup required" mode can't be reached from the web while no admin exists. |
| `.env` and the `.secrets/*.pem` certificate | Use the App Service **managed identity** for Speech, OpenAI and Storage, with no certificate or secret. Put any remaining secrets in **Key Vault** references. Delete the local certificate credential from the app registration once nothing uses it. |
| SQLite database in `data/` | On App Service, local disk is temporary or shared. Put the database on persistent storage (`/home`), or move to Azure SQL or PostgreSQL. Keep it out of `wwwroot`. Back it up. |
| The gateway checks that the caller is the local app's identity | Once the app and gateway run in the same service, remove the proxy hop or limit it to the app's managed identity. Retire the `Audio.Manage` assignment for the local app once it's no longer needed. |

**Optional extra layer:** turn on App Service Authentication (Easy Auth) with Entra External ID or Microsoft accounts, and keep the app's own allowlist behind it. Anonymous internet traffic would then never reach your Node code. If you do this, read the user identity only from Easy Auth's injected headers, and only after confirming that direct access bypassing Easy Auth isn't possible.

### Finding 6 — No per-user usage quotas (Info)

**Current controls:** uploads capped at 500 MiB and 4 hours of audio, at most 5 jobs running at once and 2 clip exports at once, and only approved users can trigger Azure calls.

**Gap:** A single approved user, or a stolen session, could submit jobs back to back all day with no limit. While every user is a friend, that's acceptable. Once hosted:
- Add per-user daily and monthly caps on audio minutes transcribed and on recap generations. Store usage counters in the database and return 429 when a cap is hit.
- Set an **Azure budget with alerts** on the subscription or resource group, for example at 50%, 80% and 100%. Consider an action group that stops the App Service at the limit.
- Set **TPM/RPM quotas** on the OpenAI deployment, and consider a lower-tier Speech quota, so the provider side caps spending even if the app's own limits fail.
- Turn on Application Insights alerts for unusual job volume.

---

## 4. Verified secure (no action needed)

**Secrets and ignore rules**
- No private keys, certificates, storage keys, SAS tokens, API keys or Discord tokens appear in any file, commit or ref.
- `.env`, `.secrets/` (the `.pem` key), `data/` (accounts database plus `-wal`/`-shm` files, recordings, transcripts, waveforms), `.venv/`, `dist/`, `node_modules/` and `detector/models/` are all ignored and were never committed.
- `.env.example` contains placeholders only. The only passwords in the repo are obvious test values in `tests/accounts.test.ts`.

**Azure gateway (`src/gateway.ts`)**
- Every request, including `/health` and `Expect: 100-continue` uploads, needs a valid bearer token before any processing.
- Tokens are verified against your tenant's published signing keys, RS256 only, with issuer, audience and expiry all enforced.
- The caller must also hold the `Audio.Manage` role, **and** its app ID and object ID must exactly match the local app.
- `appRoleAssignmentRequired = true` is set on the gateway's service principal.
- Blob names must strictly match `<uuid>/mono.mp3`, checked against the raw URL, so path traversal doesn't work.
- Uploads are limited to 128 MiB, require an exact `Content-Length`, and allow 2 at a time.
- Errors return generic messages.

**Accounts and allowlist (`src/accounts.ts`, `src/app.ts`)**
- Every `/api` route except sign-in, registration, logout and reset requires an approved, active account (`src/app.ts` ~54).
- Every `/api/jobs/:id/*` route checks that the caller owns the job, and the job list is filtered by owner.
- Waveform, clip export and upload re-check permission after slow operations finish.
- Registering without an invitation only creates a *pending* account, which can't use any Azure-backed feature.
- The admin role can't be gained through the API. Admin routes require the admin role, and admin accounts can't be changed through the API.
- Invite and reset tokens are single-use, expire, are bound to one email or user, and are stored only as hashes.
- Emails are trimmed and lowercased before comparison.
- Passwords are hashed with scrypt (N=32768, r=8, p=3) and compared in constant time. Unknown emails take the same time to check, so attackers can't tell which accounts exist.
- Session tokens are random 256-bit values stored hashed. Cookies are `HttpOnly` and `SameSite=Strict`, and sessions last 12 hours.

**Browser and cross-site protections**
- Cross-site request forgery is blocked three ways: a matching Origin header, a `Sec-Fetch-Site` check, and an `X-CSRF-Token` required on every request that changes something.
- A Host allowlist blocks DNS-rebinding attacks.
- The Content-Security-Policy is strict (`script-src 'self'`, `frame-ancestors 'none'`). The frontend never inserts HTML from data (no `innerHTML` or `eval`).

**Injection, files and network calls**
- All SQL is parameterized.
- FFmpeg, ffprobe and Python run with argument arrays, no shell, and only paths the server chose.
- Uploads are saved as `original.mp3` in a new random-ID folder, and clip download filenames are sanitized.
- Azure endpoints come from config and must be HTTPS on Azure domains.
- Result URLs returned by Speech are validated, never receive the bearer token, and redirects are refused.
- The recap prompt labels transcript text as untrusted. The model has no tools, and every source ID it cites is validated.
- The YAMNet model download is pinned to a SHA-256 hash, and the archive is checked for unsafe paths and links before extracting.

**Dependencies:** `npm audit --omit=dev` reports 0 vulnerabilities.

---

## 5. Pre-publish checklist (GitHub)

- [ ] Finding 1: replace real Azure IDs and names in `README.md`, `PLAN.md`, `infra/*.json` and `infra/deploy-gateway.ps1` with placeholders or parameters.
- [ ] Finding 2: publish from a fresh orphan branch with a GitHub no-reply email, and push only that branch.
- [ ] `git status --ignored` shows `.env`, `.secrets/` and `data/` as ignored (`!!`).
- [ ] `git ls-tree -r --name-only HEAD` on the public branch lists none of: `.env`, `.secrets/`, `data/`, `.venv/`, `dist/`, `node_modules/`, `detector/models/`, `detector/__pycache__/`, `*.pem`, `*.sqlite*`, `*.mp3`.
- [ ] Re-run a secret scan on the final branch (for example `gitleaks detect` or GitHub secret scanning plus push protection once the repo exists).
- [ ] Azure: `disableLocalAuth = true` on Speech and OpenAI (or rotate their keys).
- [ ] Azure: Storage still has anonymous and shared-key access disabled, with the network perimeter enforced.
- [ ] Azure: gateway App Service has HTTPS Only on and minimum TLS 1.2.
- [ ] Azure: budget alert configured.
- [ ] Rotate the local certificate credential if the `.pem` has ever left this machine. Keep its expiry short.
- [ ] On GitHub: turn on secret scanning, push protection, Dependabot alerts, and branch protection for `main`. Make sure any future Actions workflow uses OIDC federated credentials, not stored secrets.

## 6. Pre-hosting checklist (Azure)

- [ ] Finding 3: set `trust proxy` to the exact hop count when hosted. Lock App Service to its front door if you add one.
- [ ] Finding 4: count only failed sign-ins toward the per-email limit (or key it by email + IP).
- [ ] Finding 5: allow only the configured public hostname and require `PUBLIC_ORIGIN`. Always use Secure cookies, and send HSTS.
- [ ] Finding 5: use managed identity instead of the certificate for Speech, OpenAI and Storage. Put remaining secrets in Key Vault.
- [ ] Finding 5: put the database on persistent, backed-up storage outside the web root.
- [ ] Finding 5: keep admin bootstrap CLI-only.
- [ ] Finding 6: add per-user usage quotas, Azure budget alerts, and OpenAI/Speech provider-side quotas.
- [ ] Optional: Easy Auth (Entra External ID) in front as a second gate.
- [ ] Optional: Front Door with WAF rate-limit rules on `/api/auth/*`.
- [ ] Re-run a security review once the hosted configuration is in place.
- [ ] Before building the Discord bot: limit it to an allowlist of guild IDs (and optionally user IDs), check that list on every command, keep the bot token in Key Vault, and turn off "Public Bot" in the Discord developer portal so only you can invite it.
