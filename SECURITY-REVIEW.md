# Security review: Session Scribe

**Last updated:** 2026-10-05
**Scope:** The whole codebase (`src/`, `public/`, `detector/`, `infra/`, `Dockerfile`), its git history, and the hosted Azure Container Apps design.
**Threat model:** The source is public. The app runs on the owner's Azure subscription for a few invited friends. The main risks are:
- someone getting past the invitation/allowlist gate;
- someone running up the Azure bill;
- someone reading another user's recordings or transcripts.

This file deliberately contains no real resource names, IDs, hostnames or email addresses. Those live in `infra/deploy.local.json` and `.private/`, both gitignored.

---

## 1. Status of findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | ⚪ LOW | Live Azure resource names and IDs were in docs, `infra/` and test fixtures | **Fixed.** Replaced with placeholders or templates; deploy scripts read a gitignored config file |
| 2 | ⚪ LOW | Personal email and agent checkpoint refs were in git history | **Fixed.** History restarted from a clean commit authored with the GitHub no-reply address |
| 3 | ⚪ LOW | `package-lock.json` resolved packages from an internal corporate npm feed | **Fixed.** Now points at the public npm registry; integrity hashes unchanged |
| 4 | 🟡 MEDIUM | No per-user limits on Azure-billed work; editing a transcript could inflate recap cost | **Fixed.** Rolling 24-hour quotas per user (uploads, audio hours, recaps, laughter runs) and a cap on transcript size for recaps (`RECAP_MAX_TRANSCRIPT_CHARS`), checked when a recap is requested, inside recap generation, and on transcript edits |
| 5 | 🟡 MEDIUM | Open self-registration let someone claim a friend's email first and wait for approval; the pending queue was unbounded | **Fixed.** Signup is invitation-only by default (`APP_OPEN_SIGNUP=false`). If open signup is enabled, the pending queue is capped at 25 |
| 6 | 🟡 MEDIUM | Behind a proxy, the per-IP rate limit became one global bucket; the per-email limit allowed targeted lockout; IPv6 hosts could rotate addresses | **Fixed.** `TRUST_PROXY=1` trusts exactly the Container Apps ingress hop, which appends the real client address (verified in production: client-supplied entries stay to its left). Only failed logins count, keyed by email + client, with a looser email-only ceiling. IPv6 clients are grouped by /64. Tests show a spoofed `X-Forwarded-For` doesn't help |
| 7 | ⚪ LOW | Disk could be filled: concurrent 500 MiB uploads, and invalid uploads kept on disk | **Fixed.** Chunked uploads allow 1 active upload per user and 3 globally, and check free space first. ffprobe validates the file before a session exists, and invalid files are deleted. Abandoned uploads are purged after 6 hours, demos are capped at 3 per user, and 30-day retention applies to every session |
| 8 | ⚪ LOW | Raw FFmpeg/Python stderr (paths, tracebacks) was returned to users | **Fixed.** Logged on the server only; users get generic messages |
| 9 | Info | Localhost-only protections needed production equivalents | **Fixed.** See §2 |
| 10 | Info | Suspended users' queued jobs kept running | **Fixed.** The runner checks that the owner is still active before billable processing |
| 11 | Info | The global JSON parser ran before the accounts router's tighter 16 KB limit | **Fixed.** The accounts router now parses first |
| 12 | 🟡 MEDIUM | *(found in final review)* A forged duration header (MP3 Xing/Info or Ogg granule) could understate length, getting past the audio-hours quota and the 4-hour cap | **Fixed.** Normalization is capped at 4 h. The length of the audio actually sent to Speech is measured from the app's own encoded output, and any excess over the header is charged to the user's quota (or the job fails) |
| 13 | 🟡 MEDIUM | *(final review)* Parallel `POST /api/uploads` requests could all pass the per-user, global and free-disk checks, allowing a disk fill | **Fixed.** Upload admission is serialized, and free space is re-checked on every chunk |
| 14 | 🟡 MEDIUM | *(final review)* A recap request racing a transcript wipe could trigger an unmetered re-transcription | **Fixed.** The job is reserved synchronously before any await. Recap-only work (persisted as `queuedOperation`) never transcribes, and expired recordings are never transcribed |
| 15 | ⚪ LOW | *(final review)* Strangers could fill the email-wide failure bucket and lock a known user out for an hour | **Fixed.** A browser that has signed in before carries a 180-day HttpOnly device token that exempts it from the account-wide bucket (the OWASP device-cookie pattern) |
| 16 | Info | Open (email-free) invitations added at the owner's request | **Designed safely.** Admin-only, single-use, 72-hour expiry, hashed at rest, revocable in bulk. They create new accounts only and can never set the password of an existing account. The redeeming email is recorded. Whoever holds the link can sign up, so share it privately |
| 17 | Info | Per-upload consent checkbox replaced by a one-time, per-account acknowledgement (owner request) | **Enforced server-side.** `POST /api/uploads` returns 403 until the account has accepted the current `CONSENT_VERSION`. The acknowledgement is audited and re-requested when the version is bumped |
| 18 | Info | Recap deployment content filter relaxed for fantasy violence and in-group humor (owner request) | **Scoped.** A custom policy blocks violence and hate only at High severity (prompt and completion), and only on this app's recap deployment. Sexual, self-harm, jailbreak and protected-material filters keep their defaults. No filter is disabled |
| 19 | Info | Names & spelling, recap corrections and voice leveling added (owner request) | **Reviewed.** New routes sit behind sign-in, CSRF and the session-ownership check; the names list is keyed to the signed-in user. The AI name check is billable, so it checks Azure readiness and the transcript size cap, reserves the session before any await, and consumes the daily recap quota; the runner re-checks that the owner is active. Transcript text, names and corrections go to the model as JSON data. Model output can't change anything by itself: each suggestion must quote text that exists in its own line, restore a listed name and stay under 200 characters, and the owner reviews it before it's applied. Inputs are bounded (300 names × 12 variants × 80 characters, 50 corrections × 500 characters, control characters rejected, 64 KB bodies). Variant matching escapes every character and uses no nested quantifiers (no ReDoS). The UI renders with `textContent` only. `?balanced=0` only switches a fixed server-side FFmpeg filter; no user input reaches FFmpeg arguments |

No critical or high findings were raised in either review. `npm audit --omit=dev` reports 0 vulnerabilities.

---

## 2. Public-hosting controls (verified by tests in `tests/hosting.test.ts`)

- **Audio cost allowance (owner request, 2026-10-05).** The default audio quota is 100 hours per user per
  rolling 24 hours, configurable with `DAILY_AUDIO_HOURS_PER_USER`, up from 24. This intentionally raises
  the billable audio allowance; upload count, per-recording duration, authentication, ownership, and
  decoded-duration quota accounting are unchanged. Tests cover the default in milliseconds, explicit
  overrides, the exact 100-hour boundary, per-user isolation, and rolling-window expiry.
- **Recap cost allowance (owner request, 2026-10-04).** The default recap quota is 100 per user per rolling
  24 hours, shared with AI name checks and configurable with `DAILY_RECAPS_PER_USER`. This intentionally
  raises the maximum billable allowance from 30; authentication, ownership, quota accounting, transcript
  limits, and the other daily quotas are unchanged. Regression tests cover the default, environment
  overrides, and rejection of the 101st recap request.
- **Host and origin.** When `APP_PUBLIC_ORIGIN` is set, only that exact host is served, and only that exact origin is accepted on state-changing requests. Invitation and reset links are built from the configured origin, never from the Host header. Binding to a non-loopback `HOST` without `APP_PUBLIC_ORIGIN` refuses to start.
- **Cookies.** `__Host-scribe_session`, with `Secure`, `HttpOnly`, `SameSite=Strict` and `Path=/`, and no Domain attribute.
- **Response headers.** `Strict-Transport-Security: max-age=31536000`, a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Opener-Policy`.
- **CSRF.** A per-session token on every unsafe request, plus Origin and `Sec-Fetch-Site` checks.
- **Timeouts.** Request headers time out after 60 s and whole requests after 5 min. Chunked uploads keep each request small, so slow-body (slowloris-style) attacks get little purchase.
- **Single writer.** `.instance.lock` prevents two processes from writing SQLite or the job store at once during deploys. In-flight Speech submissions finish before shutdown, so they aren't billed twice.

## 3. Verified secure (unchanged from earlier reviews)

- **Route guards.** Every `/api` route except `/api/auth/*` requires an active account and checks CSRF on unsafe requests. Every `/api/jobs/:id/*` route checks ownership and returns the same 404 for other users' sessions. `/api/uploads/:id/*` checks that the caller owns the upload. Admin routes require the admin role, and admins cannot read other users' sessions.
- **Passwords and tokens.**
  - Passwords are hashed with scrypt (N=32768, r=8, p=3) and compared in constant time. Unknown accounts take the same time to check, and the number of concurrent hashes is limited.
  - Sessions, invitations and reset links use 256-bit random tokens stored only as hashes. Invitation and reset links are single-use and bound to one email or user, with short expiry.
  - The admin is created only by the bootstrap CLI, and admin accounts can't be modified through the API.
- **Injection.** All SQL is parameterized. FFmpeg, ffprobe and Python run with argument arrays and no shell, on server-chosen paths. The client never chooses a storage path.
- **Outbound calls (SSRF).** Speech result URLs must match the configured endpoint and are fetched without the bearer token. Redirects are refused, and endpoint suffixes are pinned.
- **Frontend.** No `innerHTML`, `eval` or inline scripts. Invitation and reset tokens travel in the URL fragment and are scrubbed from the address bar after reading.
- **Gateway** (development only). RS256 tokens checked against the tenant's published keys, plus issuer, audience, role, and the exact caller app and object IDs. Only `<uuid>/mono.mp3` paths are accepted, with size and concurrency limits.
- **Detector.** The model download is pinned by SHA-256, extraction is safe, and the model is fetched at image build time, never at runtime.

## 4. Azure hosting posture

- **Compute.** Container Apps on the Consumption plan, with exactly one replica (`min = max = 1`), so it can't scale up into surprise charges.
- **Identity.** A user-assigned managed identity with only these roles:
  - AcrPull on the registry;
  - Cognitive Services Speech User and OpenAI User on the AI account;
  - Storage Blob Data Contributor scoped to the single Speech-input container.

  There are no keys, connection strings or certificates in the app or the image.
- **Storage (cost-driven split).** Persistent data and temporary Speech audio live in a separate
  subscription and tenant, in one Standard storage account:
  - HTTPS/SMB 3 only, TLS 1.2, no anonymous blob access.
  - Access requires the account key, which is held only as a Container Apps secret.
  - The account has a public endpoint protected by that key (the same model as many small apps). This trades
    the private-network isolation of the previous design (about $60–80/month) for about $1–3/month.
  - Speech reads each temporary file through a 48-hour, read-only, single-blob SAS. The file is deleted after
    transcription, with a 3-day lifecycle rule as backup.
  - **If the key leaks, recordings and transcripts in that account are readable.** To rotate it:
    1. Run `az storage account keys renew` for both keys.
    2. Run `provision.ps1`, which updates the share mount.
    3. Run `deploy.ps1`, which updates the app secret.
    4. Restart the active revision.

    The old replica loses its mount at step 1. It gives up its lock and exits, so expect a minute or two of
    "starting" responses.- **Process privileges.** The container starts as root only long enough to make `/data` writable by `node`. It then drops to `node` via `setpriv` with no capabilities and `no_new_privs`. Account administration (`scribe-admin`) also runs as `node`.- **Images.** Built in ACR from an allowlisted `.dockerignore`, so `.env`, `.secrets/`, `data/` and `.private/` are never uploaded. The container runs as a non-root user (`node`).
- **Deploys.** Manual only (`infra/deploy.ps1`). There is no CI/CD, no stored GitHub secrets, and nothing deploys on push.
- **Backups.** Only the accounts database, kept for 14 days. Recordings and transcripts are not copied, so deletion and expiry are real.

## 5. Residual risks and recommendations

| Risk | Recommendation |
|------|----------------|
| A friend's account is phished, or they reuse a password | Quotas cap the damage. Suspend the account from Access management, which revokes its sessions immediately. |
| Key-based access on the shared AI account | Verified: the AI account already has `disableLocalAuth=true`, so only Entra ID tokens work. Keep it that way. |
| No hard spending cap in Azure | Budgets only alert. `provision.ps1` creates two: one for the app's resource group and one filtered to the AI account. Both email subscription Owners at 80% and 100% of actual spend and at 100% of forecast. The per-user quotas are the real limiter. Keep the OpenAI deployment's tokens-per-minute (TPM) capacity modest. |
| SQLite on an SMB share | Safe only with one writer: rollback-journal mode, `nobrl`, and the instance lock. Never raise `maxReplicas` above 1. |
| Storage account reachable from the internet (key-protected) | Accepted for cost. Keep the key only in Container Apps secrets, rotate it if it's ever exposed, and keep anonymous access off. |
| Opus playback depends on the browser | Some embedded browsers lack Opus decoding. MP3 always works. |
| The default `*.azurecontainerapps.io` hostname | Fine to use. A custom domain gets a free managed certificate; update `APP_PUBLIC_ORIGIN` when you switch. |

## 6. Pre-publish / pre-deploy checklist

- [x] No real identifiers in tracked files; `git grep` for subscription/tenant/resource names returns nothing.
- [x] `.env`, `.secrets/`, `data/`, `.private/` and `infra/*.local.*` are gitignored and excluded from the Docker build.
- [x] Secret scan (`detect-secrets`) over tracked files finds only test fixtures and the model checksum.
- [x] Clean history authored with a GitHub no-reply address.
- [ ] On GitHub: turn on secret scanning, push protection and Dependabot alerts.
- [x] In Azure: budget alerts on the app's resource group and on the AI account.
- [x] `disableLocalAuth=true` on the AI account (verified).
