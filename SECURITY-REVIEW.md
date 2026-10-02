# Security review: Session Scribe

**Last updated:** 2026-10-02
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
| 6 | 🟡 MEDIUM | Behind a proxy, the per-IP rate limit became one global bucket; the per-email limit allowed targeted lockout; IPv6 hosts could rotate addresses | **Fixed.** `TRUST_PROXY_HOPS` trusts exactly the configured number of proxies. Only failed logins count, keyed by email + client, with a looser email-only ceiling. IPv6 clients are grouped by /64. Tests show a spoofed `X-Forwarded-For` doesn't help |
| 7 | ⚪ LOW | Disk could be filled: concurrent 500 MiB uploads, and invalid uploads kept on disk | **Fixed.** Chunked uploads allow 1 active upload per user and 3 globally, and check free space first. ffprobe validates the file before a session exists, and invalid files are deleted. Abandoned uploads are purged after 6 hours, demos are capped at 3 per user, and 30-day retention applies to every session |
| 8 | ⚪ LOW | Raw FFmpeg/Python stderr (paths, tracebacks) was returned to users | **Fixed.** Logged on the server only; users get generic messages |
| 9 | Info | Localhost-only protections needed production equivalents | **Fixed.** See §2 |
| 10 | Info | Suspended users' queued jobs kept running | **Fixed.** The runner checks that the owner is still active before billable processing |
| 11 | Info | The global JSON parser ran before the accounts router's tighter 16 KB limit | **Fixed.** The accounts router now parses first |

No critical or high findings were raised in either review. `npm audit --omit=dev` reports 0 vulnerabilities.

---

## 2. Public-hosting controls (verified by tests in `tests/hosting.test.ts`)

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
- **Storage.**
  - The persistent file share's storage account has **public network access disabled** and is reachable only through a private endpoint in the app's VNet.
  - Its account key is held as a Container Apps environment secret, which SMB mounts require.
  - The Speech-input Blob account keeps its existing perimeter, firewall, and disabled anonymous and shared-key access. The app reaches it through its own private endpoint.
- **Images.** Built in ACR from an allowlisted `.dockerignore`, so `.env`, `.secrets/`, `data/` and `.private/` are never uploaded. The container runs as a non-root user (`node`).
- **Deploys.** Manual only (`infra/deploy.ps1`). There is no CI/CD, no stored GitHub secrets, and nothing deploys on push.
- **Backups.** Only the accounts database, kept for 14 days. Recordings and transcripts are not copied, so deletion and expiry are real.

## 5. Residual risks and recommendations

| Risk | Recommendation |
|------|----------------|
| A friend's account is phished, or they reuse a password | Quotas cap the damage. Suspend the account from Access management, which revokes its sessions immediately. |
| Key-based access on the shared AI account | If nothing else needs keys, set `disableLocalAuth=true` on the Speech/OpenAI account. The app uses only Entra ID. *Not changed automatically, because other apps may share that account.* |
| No hard spending cap in Azure | Budgets only alert. Keep the quotas. Set a subscription or resource-group budget with email alerts, and keep the OpenAI deployment's tokens-per-minute (TPM) capacity modest. |
| SQLite on an SMB share | Safe only with one writer: rollback-journal mode, `nobrl`, and the instance lock. Never raise `maxReplicas` above 1. |
| Opus playback depends on the browser | Some embedded browsers lack Opus decoding. MP3 always works. |
| The default `*.azurecontainerapps.io` hostname | Fine to use. A custom domain gets a free managed certificate; update `APP_PUBLIC_ORIGIN` when you switch. |

## 6. Pre-publish / pre-deploy checklist

- [x] No real identifiers in tracked files; `git grep` for subscription/tenant/resource names returns nothing.
- [x] `.env`, `.secrets/`, `data/`, `.private/` and `infra/*.local.*` are gitignored and excluded from the Docker build.
- [x] Secret scan (`detect-secrets`) over tracked files finds only test fixtures and the model checksum.
- [x] Clean history authored with a GitHub no-reply address.
- [ ] On GitHub: turn on secret scanning, push protection and Dependabot alerts.
- [ ] In Azure: a budget alert on the app's resource group and on the AI account.
- [ ] Optional: `disableLocalAuth=true` on the AI account (see §5).
