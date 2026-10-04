# Session Scribe

A private web app for recorded Dungeons & Dragons sessions. It runs locally for development and on Azure Container Apps for a small invited group. Upload an MP3 or Ogg Opus recording (`.opus` or `.ogg`), get a timestamped speaker-labelled transcript, rename speaker labels, and generate a chronological story recap. See [PLAN.md](PLAN.md) for feasibility and the Discord phase, and [PRODUCT-PLAN.md](PRODUCT-PLAN.md) for the application design, password accounts, administrator approval/whitelisting, per-user ownership, and 30-day recording retention. Hosting is described in [Hosting on Azure](#hosting-on-azure) and security posture in [SECURITY-REVIEW.md](SECURITY-REVIEW.md).

## What works

- Application-first UI with a searchable/filterable session library, dedicated import dialog, focused transcript/recap reading area, speaker/recording inspector, readable typography, and light/dark appearance.
- SQLite-backed email/password accounts, revocable login sessions, pending-access approval, administrator whitelists, single-use invitations and password-reset links, and server-enforced session ownership.
- Working status polling, transcript search, speaker renaming, phrase text/speaker editing, and individual entry deletion. Library navigation and future-feature previews do not discard editing drafts or reset playback.
- Centered pinned recording player with content-sized title/status beside wide controls, separated by a fixed gap rather than a stretching text column. Controls span about 60% of the screen. Transcript timestamps, recap recording-navigation links, and older paragraph references seek without starting playback automatically.
- Azure Speech **batch** transcription with diarization, one recording per job. MP3 and Ogg Opus inputs are validated by their actual container/codec, then converted to mono MP3 because batch diarization requires mono. Ogg Vorbis and other codecs are not accepted.
- Up to **500 MiB per upload and 4 hours per recording**. Longer recordings are rejected explicitly, not truncated. Splitting them manually produces separate speaker labels.
- Azure OpenAI story recaps: the entire transcript is read in bounded chunks to extract chronological scene notes, then a separate writing pass produces narrative prose inspired by human-written session recaps. The writer favors concrete choices, character moments, discoveries, earned humor, and story-relevant mechanics over a category-led fact ledger. Nearby YAMNet reactions are soft selection clues, not proof that a line caused laughter. Paragraphs do not require model-generated citations. Optional **Recording navigation** lists source-chunk time ranges retained by the application, with seek and clip actions; these are approximate scene locations, not verified support for individual claims. Longer note sets are consolidated in order before writing.
- Local/worker-side YAMNet laughter detection with a timestamped laughter index. Each suggestion can seek the retained recording and open the existing clip editor around the reaction.
- Downloads: JSON, timestamped TXT, SRT, transcript Markdown, and separate recap Markdown. Exports include saved corrections.
- Audio clips: use **Clip** beside a transcript timestamp or recap reference. The custom player starts 30 seconds before and 20 seconds after that timestamp (clamped to the original recording). Drag Start/End handles on its highlighted timeline, click/drag the playhead to seek, and play/replay the selection. Boundaries update live without pausing playback; playback stops at the current end. The timeline opens zoomed around the selection; **Full recording** and **Zoom to selection** switch its scale. Handles support touch and keyboard (arrows 0.1s, Shift + arrows 1s, Page Up/Down 10s, Home/End limits). Numeric inputs remain for millisecond-precision edits. Save a range or save and export a 192 kbps MP3; saved clips appear in the session inspector for editing and repeat export.
- Jobs/transcripts persist as JSON under `DATA_DIR`. On restart, in-progress jobs resume; saved Azure job URLs are polled rather than resubmitted. An instance lock guarantees that only one process uses `DATA_DIR`; during a rolling deploy the new container waits for the old one to release it.
- Uploads are sent in resumable 8 MiB chunks (`/api/uploads`), so no request runs long enough to hit proxy timeouts and a dropped connection resumes from the last confirmed byte. Recordings are checked with ffprobe before a session is created; invalid files are deleted immediately.
- Transcripts survive recap failures. Recaps can be retried independently.
- **Bottom player skip controls:** ↺ 10 / 10 ↻ buttons (and Shift+←/→ outside text fields) jump 10 seconds in long recordings.
- **Waveforms for long recordings** are built in the background. The clip editor shows "Analyzing…" and polls instead of
  holding a request open past proxy time limits, and waveforms are pre-built right after a processing run finishes.
- **Recap resilience.** Model failures are reported specifically: content filter (with category), truncation, which is
  retried once with a larger allowance, or refusal. A transcript slice that the content filter blocks is skipped and
  listed in the recap's uncertainties with its time range, instead of failing the whole recap. `provision.ps1` gives
  the recap deployment a custom content filter that blocks violence and hate only at **High** severity, so fantasy combat
  and in-group/self-deprecating table humor aren't filtered. Sexual, self-harm, jailbreak and protected-material filters
  keep their defaults.
- **Upload progress** is shown front and center in the import dialog: a byte-accurate progress bar, MB done, speed,
  time left, a "keep this tab open" warning and **Cancel upload**. Starting a new upload replaces an abandoned one
  (closed tab, cancelled), so an interrupted upload never blocks the next.
- **Delete sessions** from the library list or the session view, even while processing. Work is stopped at the next
  checkpoint (local tools are killed, the Azure Speech job is cleaned up), and the session disappears immediately and
  is deleted as soon as the work has stopped. This also completes after a restart.
- **Sessions process side by side.** Up to six sessions run at once. CPU-heavy steps (audio conversion, laughter
  detection, waveform building) take turns on the single vCPU, and recap writing allows two at a time. While Azure
  transcribes a session, its laughter detection and waveform run in parallel instead of first, and other sessions
  keep moving. A long recording no longer holds up a short one.
- **Progress for long-running work.** Processing, recap regeneration and laughter re-runs show the full checklist of
  steps (done with durations, in progress, and still to come), what each step unlocks (laughter index, clip-editor
  waveform, transcript and exports, recap), a "Not ready yet: …" banner, and an estimated progress bar with time remaining.
  Estimates come from `DATA_DIR/stage-timings.json`, which learns each stage's fixed overhead and per-audio-minute
  cost from recent runs. The server also logs every stage's duration. Completed steps are real; the current step's
  fill is an estimate (recap writing reports real chunk progress).
- **Recording consent is acknowledged once per account**, at invitation sign-up or on the first import, and stored
  server-side (`users.consentVersion`). Uploads are refused until it has been given. Bumping `CONSENT_VERSION` in
  `src/accounts.ts` asks everyone once more.
- **Names & spelling.** Azure batch transcription can't take a vocabulary list, so misheard names are fixed after
  transcription. Each account keeps a **names list** (correct spellings plus "heard as" variants, e.g. *Lostleton* ←
  "Lonelywood"), stored in the accounts database and shared by all of that user's sessions. In the **Names & spelling**
  tab:
  - **Fix "heard as" spellings:** previews then applies whole-word, case-insensitive replacements of the listed
    variants. Instant and free.
  - **Find more with AI:** GPT-5.4 reads the transcript in chunks with the names list and proposes fixes for other
    mishearings (accents, split words). Every suggestion is validated (the original text must exist in that line, the
    fix must restore a listed name) and reviewed before anything changes; accepted spellings can be remembered in the
    names list. Counts as one recap toward the daily quota.
  - With the account setting on (default), listed variants are fixed automatically on new transcripts before the
    recap is written. The names list is also passed to the recap writer as spelling guidance.
  Fixes only change line text, so segment IDs, timestamps, clips and laughter links stay valid; a saved recap is
  marked out of date.
- **Out of context quotes.** While the recap reads the raw transcript, it also nominates up to six lines per part
  that are funny or baffling on their own. Each must match the words of a real line (or up to three consecutive lines
  by one speaker, since Speech splits sentences), or it is dropped. Lines followed by laughter score higher. The recap keeps a
  ranked pool of up to 30 (ranking spreads the best across the session: two per part first, then the rest). **Out of
  context** at the end of the recap shows the top 5, 10, 20 or all (remembered per browser) in spoken order, each with
  the speaker's current name, a timestamp and a **Clip** button. **Copy list** copies just the quotes, one per line in
  double quotes, and the recap Markdown includes the same number. No extra model calls; existing
  sessions get quotes when their recap is regenerated.
- **Corrections for the next recap.** Each recap uncertainty has a **Clarify** button, and free-form corrections can
  be added below the recap. Saved corrections are stored on the session and given to the recap writer as authoritative
  facts on every regeneration.
- **Even out voices.** A toggle in the bottom player and the clip editor (on by default, remembered per browser) runs
  playback through a compressor with make-up gain so quiet speakers are audible next to loud ones. Clip exports apply
  FFmpeg `dynaudnorm` plus a limiter when the toggle is on. The mono copy sent to Azure Speech is leveled the same way
  (`SPEECH_INPUT_LEVELING`, default `true`); the stored original is never modified.
- Fictional demo works without credentials and makes **no Azure calls**.
- Consent required for real uploads; private temporary Azure blobs, SP/MSI authentication, Speech managed-identity reads, audio cleanup, explicit deletion, and cleanup warnings.

**Public hosting is opt-in and exact.** With `APP_PUBLIC_ORIGIN` blank the server accepts only localhost Host headers. When it is set, only that exact HTTPS host is accepted, cookies become `Secure`/`__Host-`, HSTS is sent, and `TRUST_PROXY` must describe the real proxy chain (`1` on Container Apps, whose ingress appends the client address). Signup is invitation-only by default (`APP_OPEN_SIGNUP=false`). Per-user daily quotas cap uploads, audio hours, recap generations and laughter runs. Recap generations and AI name checks share a default limit of **100 per user per rolling 24 hours**, configurable with `DAILY_RECAPS_PER_USER`.

**30-day recording retention is active.** Each original recording gets a fixed expiry 30 days after its upload was accepted (`RECORDING_RETENTION_DAYS`). Playback, waveforms, clip preview/export and laughter re-runs stop at that moment even before the background sweep physically deletes the file, which happens within about ten minutes. Transcripts, recaps, speaker names, laughter timestamps and saved clip ranges stay until the session is deleted. Sessions accepted before retention existed use their creation time as the upload time. The inspector shows days remaining, warns during the last 7 days, and offers **Download original**.

## Accounts and administrator setup

Requires Node **22.13 or newer** with built-in SQLite support. Use one application process/replica and a persistent local disk for `DATA_DIR`. The account database is `accounts.sqlite`; session transcripts/recaps and recordings retain their existing files under the same directory.

Create your initial administrator from a trusted local terminal:

```powershell
npm run users:bootstrap -- --email you@example.com
```

Passwords may contain **8–128 characters**, with no composition requirements. This applies to administrator setup, signup/invitations, and password resets; longer unique passwords are still preferable.

The command prompts for a password and confirmation without echoing them. Do not put passwords in command arguments, source, `.env`, or chat. There is no default password, no first-web-signup administrator, and no administrator role granted by matching an email string. An optional `APP_ADMIN_EMAIL` reserves the intended email for bootstrap; the durable database record controls the role. If no administrator exists, the browser shows setup instructions instead of exposing sessions.

After signing in as administrator:

1. **Don't know their email?** Choose **Create open invitation** in Access management and send them the one-use link
   (or just the token, which they paste into the sign-up form's **Invitation token** field). They choose their own
   email and password. Open invitations expire after 72 hours, can't be used to take over an existing account, and
   **Revoke unused open invitations** cancels any you've handed out but don't want used.
2. **Know their email?** Add it to the whitelist and generate an invitation bound to that address, then share the
   one-use link directly with the intended person.
3. The recipient chooses a password through that invitation; the bound account becomes active immediately.
4. Without an invitation, signup creates a pending account. It can sign in to see **“Talk to the admin to enable access”**, refresh status, or sign out, but cannot use session APIs.
5. Approve an ordinary pending request only after confirming the requester is the intended person. Alternatively, send a bound invitation. Admin-issued links avoid an email-delivery service; an email string alone never proves identity.

Invitation links expire after 72 hours. Administrator-issued password-reset links expire after one hour, are one-use, and revoke prior login sessions when redeemed. Links contain sensitive tokens in the URL fragment, not a server query string; the browser removes the fragment after reading it. Share links confidentially and do not paste them into logs. Only token hashes are stored.

Removing a whitelist entry stops issuing new invitations for it; it does not revoke an existing approved account. Suspend the account to revoke access and login sessions. Administrator access management does **not** grant access to another user's recordings. New imports/demos are owned by the authenticated account; all job reads, ranged audio, edits, exports, recap requests, and deletion routes check ownership.

Rejected/suspended accounts are signed out. Subsequent login failures remain generic rather than disclosing an account's status; contact the administrator if access has changed.

The five earlier test sessions were removed at the owner's request when accounts were introduced. Unowned legacy files are not automatically exposed or adopted by a new account.

### Clip timeline controls

Clips can have an optional name (up to 120 characters). Enter it before saving, or use **Edit / preview** on a saved clip to rename it. Names appear alongside the saved timestamps and are used for MP3 download filenames, with unsupported filename characters sanitized. Existing clips remain available as **Unnamed clip** until named; leaving the name blank is supported.

In the clip editor, **right-click and drag the waveform** to pan the visible window after zooming. Drag left to reveal later audio; drag right to reveal earlier audio. Panning stays inside the recording and preserves the zoom scale, clip boundaries, and current playback. A timestamp ruler shows absolute recording times, with finer tick spacing and fractional seconds as you zoom in. The normal browser context menu is suppressed only on the waveform timeline.

### SQLite operations

Clip metadata (session ID, optional name, start/end milliseconds, creation date) is stored in the same SQLite database. Existing databases migrate automatically. Session deletion removes its clip records. Exported files are generated from the original on demand and temporary files are removed afterwards; clips are not separate permanent recordings. If the original becomes unavailable, saved ranges remain visible but audio export is unavailable. Clip exports use local FFmpeg, not Azure, with at most two concurrent exports and one per session.

The clip timeline shows a real peak-amplitude envelope so quiet gaps are visible. Hover over the timeline and scroll up to zoom in or down to zoom out, anchored at the mouse position (down to a one-second visible window). Zooming does not change the saved clip boundaries or interrupt playback. The first waveform request streams the recording through local FFmpeg, then saves a compact 10 ms-resolution peak cache alongside the session. It uses the louder stereo channel, not a potentially cancelling mono mix. Subsequent views reuse that cache and return at most 2,048 peaks; the browser never decodes the whole recording into memory. Up to two waveform jobs run at once. The cache is private to the session owner and deleted with the session; waveform failures have a retry action and do not disable clipping.

- Keep the database, any SQLite WAL files, and session/media files on persistent storage outside the public directory. Never deploy a fresh database over an existing installation.
- SQLite is the chosen production account datastore for this small, single-instance application, not a temporary Azure SQL dependency. Do not run multiple application instances, use a shared network filesystem, or scale replicas against this data directory.
- SQLite WAL requires appropriate local filesystem locking. Do not assume an Azure Files/SMB mount or an App Service shared home directory is a suitable database volume; validate the hosting storage choice before deployment.
- For a consistent full backup, stop the application and copy the entire `DATA_DIR`, including the account database and recordings. Restore it as a set before restarting. Copying only a live database file can lose WAL transactions; copying only session files loses ownership.
- Protect disk access and backups: password hashes are not plaintext, but the database and recordings still contain private data. Account auth does not encrypt local disk.
- Keep the existing SP/MSI Azure configuration separate. Browser accounts do not receive Azure credentials or subscription permissions.

## Run locally on Windows

Requirements: Node.js 22+ (tested here with Node 24), npm, FFmpeg + ffprobe on PATH for real audio,
and Python 3.11 for laughter detection.

```powershell
npm install
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r detector\requirements.txt
.\.venv\Scripts\python.exe detector\download_model.py
# Only for a new setup: do not overwrite a configured .env.
Copy-Item .env.example .env
# Edit .env with resource endpoints and your app identity configuration.
npm run dev
```

Open `http://127.0.0.1:3000`. You can explore the fictional demo before configuring Azure. You do not need FFmpeg for the demo.

Set `PYTHON_PATH=.\.venv\Scripts\python.exe` on Windows. The model downloader installs the pinned
official YAMNet 1 SavedModel after verifying its archive hash. See
[detector/README.md](detector/README.md) for the detector command contract and container guidance.

Laughter detection runs as a separate process and emits validated versioned JSON. This is also the
production boundary: an Azure Container Apps Job can download a private recording to ephemeral
storage and invoke the same detector without changing its inference code. Install Python,
`detector/requirements.txt`, FFmpeg, and the model in the worker image at build time.

The default Speech API version is **2025-10-15**. Batch submissions use `properties.diarization = { enabled: true, maxSpeakers: job.maxSpeakers }`, as defined by the generated REST reference's [DiarizationProperties](https://learn.microsoft.com/rest/api/speechtotext/transcriptions/submit?view=rest-speechtotext-2025-10-15#diarizationproperties). Do not use the legacy `diarizationEnabled` or nested `diarization.speakers` fields with this version: the live service silently ignored them, omitted diarization from the submission response, and returned Unknown labels for every phrase. Existing affected transcripts cannot acquire speaker labels through a recap retry; they require a new transcription. The corrected contract has completed a live synthetic two-voice diarization/transcript/recap run; human long-recording quality is not yet verified.

For recaps, use a capable general-purpose model such as **GPT-5.4** rather than GPT-4o-mini for long, detailed sessions. `AZURE_OPENAI_DEPLOYMENT` is the Azure deployment name, not necessarily the model name. The recommended deployment name is `session-scribe-recap`. Set `AZURE_OPENAI_REASONING_EFFORT=low` for GPT-5.4, or leave it blank for a non-reasoning model; only send effort values supported by your chosen model. `AZURE_OPENAI_MAX_COMPLETION_TOKENS` defaults to 16,000 and includes both reasoning and visible output on reasoning models. These settings apply to extraction, consolidation, and final writing and work unchanged in an Azure worker.

For a compiled run:

```powershell
npm run build
npm start
```

Run from the project root so the server can find `public`. Configuration is loaded at startup; restart after changing `.env`.

### Provision these Azure resources

1. **Azure AI Speech / Foundry Speech resource, Standard S0**, in a region supporting batch transcription. No separate speech model deployment is required; the default base model is used. Enable its **system-assigned managed identity** for private audio reads.
2. **Azure Storage account and precreated private `dnd-audio` container**, anonymous access and shared-key authentication disabled. The app uses Entra Blob authorization directly or the optional authenticated storage gateway below; Speech uses its own managed identity and plain source URLs, with no source SAS. Network rules must permit the uploader (local app or gateway) and Speech reads independently. RBAC alone does not bypass a firewall.
3. **Azure OpenAI resource / Foundry Azure OpenAI deployment**, preferably **GPT-5.4**, supporting chat completions and strict JSON Schema structured output. Set the **deployment name**, not necessarily the model name. The app uses `/openai/v1/chat/completions`, not the project inference endpoint. Arbitrary Foundry catalog models are not interchangeable with this API. The same Foundry account may supply Speech and OpenAI.
4. Blob lifecycle policy deleting temporary audio after **3 days**, as a crash safety net. The provisioning policy is in [infra/storage-lifecycle.json](infra/storage-lifecycle.json). Runtime cleanup still deletes audio immediately when processing finishes.

Set:

```dotenv
AZURE_AUTH_MODE=certificate
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-app-client-id
AZURE_CLIENT_CERTIFICATE_PATH=./.secrets/dnd-session-scribe.pem
AZURE_SPEECH_ENDPOINT=https://your-ai-resource.cognitiveservices.azure.com
AZURE_STORAGE_ACCOUNT_URL=https://your-storage-account.blob.core.windows.net
AZURE_STORAGE_CONTAINER=dnd-audio
AZURE_OPENAI_ENDPOINT=https://your-ai-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
```

### Authentication and least privilege

- `certificate`: local service principal using a PEM file containing certificate + private key. The app never falls back to an administrator's CLI session if certificate auth fails. Protect this file with an owner-only ACL, keep it outside source control, and rotate it before expiration.
- `managed-identity`: Azure-hosted system-assigned MSI when `AZURE_CLIENT_ID` is blank, or user-assigned MSI when a client ID is set. The local certificate is not needed; assign the MSI the same runtime roles.
- `azure-cli`: explicit developer-only mode using the signed-in CLI identity. This is not selected in the configured app.

Required assignments:

| Identity | Role | Scope |
| --- | --- | --- |
| App SP/MSI | Cognitive Services Speech User | Speech/Foundry account |
| App SP/MSI | Cognitive Services OpenAI User | OpenAI/Foundry account |
| App SP/MSI (direct storage only), or gateway system-assigned MSI | Storage Blob Data Contributor | Audio container |
| Speech account's system-assigned MSI | Storage Blob Data Reader | Audio container |

Provisioning creates the container; the app cannot create accounts or assign roles. The runtime does not request storage keys or delegation keys, and has no subscription-wide role.

Only public Azure cloud endpoint suffixes are currently accepted; sovereign clouds need endpoint validation and result-host changes. Access tokens/private certificates stay server-side, never in browser responses. Do not commit `.env`, `.secrets`, transcripts, or recording data. The data directory is unencrypted local disk; use disk encryption and appropriate access controls.

### Storage networking in this tenant

Inherited policy forces ordinary storage public access off but permits **Network Security Perimeter** protection (`SecuredByPerimeter`). Storage remains `SecuredByPerimeter` with an **Enforced** perimeter, firewall default **Deny**, anonymous access disabled, and shared-key authentication disabled. The configured local app uploads/deletes through the authenticated gateway's private endpoint path, not public Blob access. Speech's source-subscription allowance and container-scoped reader role remain independent; both the gateway path and the complete Speech/recap pipeline have passed a live synthetic test. For optional direct local uploads, an explicit current-public-IP rule would be needed; that is not the configured gateway path. Subscription-based network rules do not grant blob permissions. The perimeter takes precedence over traditional firewall/resource-instance rules. No policy exemption, account keys, or anonymous access is needed.

Microsoft guidance: [Storage and Network Security Perimeter](https://learn.microsoft.com/azure/storage/common/storage-network-security-perimeter) and [Speech managed-identity audio reads](https://learn.microsoft.com/azure/ai-services/speech-service/batch-transcription-audio-data#trusted-azure-services-security-mechanism).

### Optional authenticated storage gateway

The local UI remains loopback-only. The separate Node entrypoint `src/gateway-server.ts` exposes **only** normalized audio upload/delete and an authenticated container probe; it does not host the UI or proxy Azure AI. Use this when local direct Blob network access is unavailable. With both gateway settings blank, the existing direct Blob upload/delete behavior is unchanged.

Local settings:

```dotenv
AZURE_STORAGE_GATEWAY_URL=https://your-gateway.azurewebsites.net
AZURE_STORAGE_GATEWAY_SCOPE=api://your-gateway-api-client-guid/.default
AZURE_AUTH_MODE=certificate
```

#### Provisioned gateway (summary)

A development gateway of this shape has been deployed and passed live checks: `401` for anonymous and wrong-audience requests, `204` for the authorized app's container probe, and real Blob upload/delete through a private endpoint. A complete local-browser → gateway → private Blob → Speech diarization → recap → cleanup run passed with synthetic audio.

| Component | Shape |
| --- | --- |
| App Service | Linux Node 22 App Service with HTTPS-only, VNet integration, and a system-assigned managed identity |
| Memory bound | `NODE_OPTIONS=--max-old-space-size=128` caps the gateway's V8 old-space heap; total process memory is not capped by this setting |
| Gateway managed identity | **Storage Blob Data Contributor scoped to the audio container** |
| Networking | Dedicated VNet with a delegated App Service integration subnet, a private-endpoint subnet, a Blob private endpoint, and the `privatelink.blob.core.windows.net` private DNS zone |
| Gateway API app registration | `appRoleAssignmentRequired=true`; one application role, `Audio.Manage` (see [infra/gateway-api.template.json](infra/gateway-api.template.json)) |
| Only assigned caller | The local certificate service principal (see [infra/gateway-role-assignment.template.json](infra/gateway-role-assignment.template.json)) |

Real resource names and identifiers belong in your private `.env`/deployment notes, not in this repository.
The narrow deployment contains only `dist/gateway-server.js`, `dist/gateway.js`, `dist/gateway-storage.js`, `dist/storage-contract.js`, root package manifests/lockfile, and production dependencies. Startup is `node dist/gateway-server.js`. Certificates, `.env`, local job/audio data, the UI, and other compiled app modules are excluded. The manual deployment helper [infra\deploy-gateway.ps1](infra/deploy-gateway.ps1) builds those four modules, restores production dependencies with `npm ci --omit=dev`, and ZIP-deploys the narrow package; deployment requires an authorized Azure operator.

The private endpoint has an **ongoing charge**. Reusing the approved plan introduces **no new hosting-plan charge**, but consumes shared S1 capacity; it does not promise unlimited uploads, dedicated capacity, or freedom from network/request/runtime limits. The **Speech resource's managed identity** retains its container-scoped Blob reader assignment and NSP subscription allowance; gateway success does not replace that separate access path or establish full pipeline readiness.

Only an HTTPS `*.azurewebsites.net` root with no path, credentials, nonstandard port, query, or fragment is accepted. Keep the normal storage account URL/container configured: the local app checks the gateway's response `audioUrl` and `Location` against that **exact** plain Blob URL. The existing explicit certificate credential obtains a separate gateway token server-side. Azure AI tokens are never sent to the gateway; gateway tokens are never sent to Speech, recap, or result URLs. Neither certificate failures nor gateway failures fall back to an administrator login or direct upload.

Gateway setup (provision/deploy separately):

1. Register a single-tenant API with Application ID URI `api://<gateway API client GUID>`, v2 access tokens (`requestedAccessTokenVersion: 2`), and an application role `Audio.Manage` allowed for applications. Assign that role to the local certificate service principal and grant administrator consent.
2. Enable the App Service's system-assigned managed identity; assign it container-scoped **Storage Blob Data Contributor**. Permit the App Service's outbound storage network path (for example, appropriate VNet integration/private endpoint and DNS). The gateway uses **only `ManagedIdentityCredential`**, never certificates, CLI fallback, storage keys, or forwarded identity headers.
3. Set App Service environment variables `GATEWAY_TENANT_ID`, `GATEWAY_AUDIENCE` (API client GUID), `GATEWAY_CALLER_CLIENT_ID` (local app client GUID), `GATEWAY_CALLER_OBJECT_ID` (**enterprise application/service-principal object GUID**, not app-registration object GUID), `AZURE_STORAGE_ACCOUNT_URL`, and `AZURE_STORAGE_CONTAINER`. `PORT` defaults to **8080**; gateway binds **0.0.0.0** regardless of local `HOST`. Keep HTTPS-only enabled at the App Service edge. JWT validation is performed by the application itself, not Easy Auth headers.
4. Run `npm run build`; deploy only the four compiled gateway modules listed above under `dist`, plus root `package.json`/`package-lock.json` and production dependencies (`npm ci --omit=dev` on a compatible Node 22+ host, or package production `node_modules`). Start with `npm run start:gateway` / `node dist/gateway-server.js` from the deployment root. Exclude TypeScript compiler tooling, `tsx`, FFmpeg, local data, PEM, `.env`, the UI, and other compiled app modules. Keep one gateway process/instance for a deployment-wide two-transfer limit; the counter is process-local.

Every endpoint requires an RS256 Bearer JWT verified using tenant-specific Microsoft JWKS, issuer `https://login.microsoftonline.com/<GATEWAY_TENANT_ID>/v2.0`, the exact configured audience, role `Audio.Manage`, and exact matching `azp` and `oid` caller claims. Authentication happens before consuming audio or touching storage, including `Expect: 100-continue` requests.

| Endpoint | Result |
| --- | --- |
| `PUT /audio/<job-uuid>/mono.mp3` | `201`, plain `Location` and JSON `{ "audioUrl": "https://account.blob.core.windows.net/container/<job-uuid>/mono.mp3" }` |
| `DELETE /audio/<job-uuid>/mono.mp3` | `204`, including already-absent blobs |
| `GET /health` | `204` only after an authenticated real container-properties probe |

Names must match the runner's lowercase UUID shape: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx/mono.mp3`. Other paths, traversal, encoded separators, query strings, arbitrary containers/URLs, lists, and downloads are rejected. Upload requires `Content-Type: audio/mpeg` and positive `Content-Length`, with a **128 MiB normalized-audio limit**, enforced both on declarations and actual streamed bytes. At most two transfers run concurrently; disconnects/oversize abort uploads and partial failures trigger deletion. Failures return `401`/`403` (auth), `400` (path/body contract), `413` (size), `429` (concurrency), or sanitized `502` (storage). Server logs retain explicit error diagnostics; cleanup failures remain visible local session warnings. Uploads are **never automatically retried**. Check App Service frontend request limits/timeouts for long recordings; the local 500 MiB original-file limit does not override the normalized gateway limit.

**Speech still needs independent Blob network access and its own reader role.** Gateway reachability does not prove Speech can fetch the plain URL. It does not tunnel Speech reads, mint a SAS, or make the container public. Preserve the storage lifecycle safety net for crashes/failed cleanup.

### Workflow

1. Get permission from everyone recorded. (You confirm this once, at sign-up or on your first import.)
2. From **Your sessions**, choose **Import recording** and upload an MP3 or Ogg Opus file (`.opus` or `.ogg`) with a session title, known language, and upper bound on speakers. Start with the actual number of players + DM, plus a little headroom. Accepted imports open the review workspace; failed uploads keep the dialog and your fields with a visible error.
3. Optionally supply character/NPC/location names. This helps **recap spelling only**, not the Speech model. It must not be used as evidence that an event occurred.
4. Wait. Batch transcription can take minutes to hours. The checklist above the transcript shows every step, what it unlocks, and an estimate. Several sessions process at once, and up to 20 can be queued.
5. Review speaker labels and low-confidence phrases. Names cannot be inferred reliably from anonymous mixed audio; rename them manually. Changed names mark an existing recap out of date but do not delete it.
6. Use the bottom player and timestamp buttons to check phrases against the original recording. Click Edit text / speaker, select the entry's speaker, correct its text, then Save. Delete entry removes only that speaker/phrase pair after confirmation, not the session or recording. Remaining timings, IDs, and order stay unchanged. Unsaved edits must be saved or discarded before switching sessions.
7. Saved changes keep the recap and mark it **Out of date**, with a shortcut to Review / Regenerate recap. A successful regeneration replaces it and clears the marker; failure keeps the previous recap. Deleted evidence references are marked unavailable instead of linked to another phrase. Recap Markdown exports carry the same out-of-date warning. The fictional demo cannot generate a new cloud recap.
8. Return to **Your sessions** to search/filter and reopen recordings. Delete the session when you no longer need the locally retained recording/transcript/context/recap.

If Azure OpenAI is not configured, transcription still runs and is retained with an explicit recap configuration error. Add the configuration, restart, and Generate recap. Failed transcription requires a new upload; its original recording remains local until session deletion.

Original recordings are now retained locally for playback, including failed jobs. Recordings already deleted by older versions cannot be recovered; re-upload them to enable playback. The demo has no real recording.

Playback uses your browser's native audio codecs. MP3 playback and timestamp navigation were verified in the embedded browser; real Ogg Opus playback and seeking were verified separately in standalone Chrome. The VS Code embedded browser used here could not decode Opus despite advertising codec support. If it reports unsupported audio, open the local app in Chrome rather than the embedded browser.

## Hosting on Azure

One small container plus SQLite on a file share, split across two subscriptions by cost and policy:

```text
Browser ──HTTPS──> Container Apps ingress (TLS; appends client IP to X-Forwarded-For)
   [app subscription]  └─ one replica (1 vCPU / 2 GiB): Node app + FFmpeg + YAMNet
                            ├─ Azure AI Speech + Azure OpenAI via user-assigned managed identity
                            │
   [storage subscription]   ├─ /data  SMB Azure Files share (account key held as a Container Apps secret)
                            │         accounts.sqlite (rollback journal), job JSON, originals, backups/
                            └─ Blob "speech-input": temporary mono audio; Speech reads it via a
                               48-hour read-only SAS link; deleted after transcription (3-day safety net)
```

- **Why split?** The app subscription's policy forbids storage account keys, so an SMB mount there needs
  a premium NFS share, private endpoints and a VNet (about $60–80/month). A standard key-authenticated share
  in a subscription without that policy costs about $1–3/month. Compute and AI stay in the app subscription.
- **Exactly one replica** (`minReplicas = maxReplicas = 1`). SQLite and the in-process job queue assume
  one writer; `.instance.lock` in `DATA_DIR` enforces it. During a rollout the new replica answers
  "starting" for a few seconds until the old one releases the lock, then resumes any in-flight jobs.
- **Secrets.** The only secret is the storage account key, held as a Container Apps secret (for the SMB
  mount and for signing Speech's read-only links). Speech and OpenAI use the managed identity; nothing is
  stored in the repository, the image or on the developer machine.
- **Least privilege in the container.** The entrypoint fixes `/data` ownership as root, then drops to
  the `node` user with no capabilities.
- **Backups.** Every day the app writes a consistent copy of `accounts.sqlite` (users, ownership,
  clip ranges) to `/data/backups/`, keeping 14. File-share soft delete keeps deleted files for 7 days.
  Recordings and transcripts are deliberately not copied elsewhere.
- **Cost guardrails.** Per-user daily quotas in the app, plus budget alerts on the app resource group,
  the AI account and the storage resource group. Budgets alert; they do not cap.

Approximate fixed hosting cost: app subscription ≈ $29/month (container ≈ $24 at the idle rate, registry $5,
logs ≈ $0); storage subscription ≈ $1–3/month. Speech and OpenAI are billed per use.
### Provision (once, re-runnable)

```powershell
Copy-Item infra\deploy.example.json infra\deploy.local.json   # gitignored; fill in real names
.\infra\provision.ps1
```

`provision.ps1` creates only app-specific resources. In the storage subscription, it creates the storage
account, file share, Speech-input container and lifecycle rule. In the app subscription, it creates the
registry, Log Analytics, managed identity and roles, the no-VNet Container Apps environment and its
share mount, plus the budget alerts. Sign the Azure CLI in to both tenants first (`az login --tenant ...`).
It does not change unrelated apps, plans or model deployments.

### Deploy (manual, whenever you choose)

```powershell
.\infra\deploy.ps1                          # build the image in ACR from the working tree, then roll out
.\infra\deploy.ps1 -SkipBuild -Tag <tag>    # roll back or forward to an existing image tag
```

There is no CI/CD and nothing deploys on push. The build context is filtered by `.dockerignore`
(an allowlist), so `.env`, `.secrets/`, `data/` and `.private/` never leave your machine.

### Custom domain

The app can be served on your own domain with a free, auto-renewing managed certificate:

1. In your DNS, add `CNAME <sub> -> <app>.<environment default domain>`, plus `TXT asuid.<sub> -> <environment
   customDomainVerificationId>` (`az containerapp env show ... --query properties.customDomainConfiguration`).
   With Cloudflare, keep the CNAME **DNS only (grey cloud)**. Proxying blocks certificate validation and adds an extra
   hop, which breaks `TRUST_PROXY=1` client-address handling.
2. `az containerapp hostname add` and `az containerapp hostname bind --validation-method CNAME --environment <env>`.
3. Set `app.customDomain` in `infra/deploy.local.json` and run `deploy.ps1`. `APP_PUBLIC_ORIGIN` becomes that domain,
   the default `*.azurecontainerapps.io` host is then refused, and each deploy restates the binding so it isn't dropped.

### Account administration in the cloud

Every command runs inside the container as the app user and prints a one-use link. No password is typed into a remote shell.

```powershell
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin bootstrap-link --email you@example.com"  # first admin (link valid 24 h)
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin reset-link --email you@example.com"      # lost password (24 h)
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin invite --email friend@example.com"       # invitation (72 h)
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin open-invite"                             # invitation for any email (72 h)
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin delete-user --email someone@example.com" # session-free non-admin
```

Normal invitations, approvals and resets are also available in the app's **Access management** page.

### Restore the accounts database

```powershell
az containerapp exec -g <resource-group> -n session-scribe --command "cp /data/backups/accounts-YYYY-MM-DD.sqlite /data/restore-accounts.sqlite"
az containerapp revision restart -g <resource-group> -n session-scribe --revision <active-revision>
```

On startup the app swaps `restore-accounts.sqlite` in once and keeps the previous database beside it
with a `.before-restore-<timestamp>` suffix.
## Limits and failure behavior

- Diarization is approximate: overlapping talk, music, mic sharing, and roleplayed voices can confuse labels. A label is not biometric identification, a character identity, or a cross-session identity.
- Timestamps are phrase-level in exported transcripts. Word timing is requested from Speech but the MVP does not persist/export individual words.
- No timestamp editing, phrase insertion/splitting, speaker merging, live capture, campaign memory, or custom vocabulary model training yet. Deleting every entry leaves an empty, exportable transcript and keeps the recording/recap; recap regeneration needs at least one remaining entry.
- Recaps are AI drafts, not fact-checked accounts. The model does not generate navigation timestamps or transcript IDs; the application attaches the original chunk ranges to scene titles from extraction. A range can include unrelated chatter or multiple scenes, and its title can be wrong. It is a navigation aid, not a citation or a proof of factual accuracy. Existing recaps retain their old paragraph references until regenerated; membership checks on those references never verified factual entailment. Invalid model JSON/schema receives one corrective retry; remaining failures are surfaced without losing the transcript or a previous recap. Refusal, truncation, and transport errors are not treated as usable prose.
- Speech job polling stops after 24 hours per worker attempt. Azure result TTL is 48 hours after completion. Source audio has no SAS expiry, but the lifecycle safety net deletes it after 3 days. Jobs exceeding these windows may need a new upload.
- Azure AI polling/recap HTTP 429/server errors are retried with bounded backoff. Speech submission and storage gateway uploads are not automatically retried because they can duplicate work.
- There is a small unavoidable crash window between Azure accepting a job and the app persisting its ID. A restart in that window can resubmit it. Production needs an idempotency/reconciliation design.
- Original audio is kept locally until session deletion, so account for disk space and recording privacy. The normalized local MP3, temporary Azure blob, and cloud transcription are deleted after completion or failure. Cleanup failures are visible in session warnings. If cleanup still fails, session deletion returns an error rather than pretending cloud data is gone. Speech results also have TTL; audio blobs only have your separately configured lifecycle policy.
- Jobs are atomic JSON writes, **single-process only**. Do not run two instances against the same data directory. The local queue is not a distributed worker and has no cancellation API.
- No precise percentage progress: stages and service status are shown, because batch APIs do not expose a reliable completion percentage.
- Missing FFmpeg, invalid MP3/Opus recordings, unsupported language/regions, quota issues, malformed service output, empty transcripts, recordings with no extracted story, and truncated/refused model output become explicit errors.

## Validation

```powershell
npm run check
npm test
npm run build
```

Tests exercise normalization, exact timestamps/exports, diarization request shape, legacy recap references, citation-free narrative persistence, application-owned scene ranges, long-transcript processing, local persistence, API actions, origin/host restrictions, audio tooling, and the gateway's injected token/storage contract (auth/caller/audience, path validation, streamed limits, concurrency, cleanup, upload/delete, exact URL checks). A real RS256/JWKS cryptographic test also checks valid signatures and rejects invalid signatures, expired tokens, and wrong audience/issuer; only its JWKS transport is injected. Live Azure gateway networking, JWT issuance, transcription/recap accuracy, and real billing require configured resources and a consented recording; fixtures and the fictional demo are not proof of those integrations.

Latest validation: **113 tests pass**, TypeScript check and build pass. Names coverage includes whole-word variant fixes that keep IDs and timestamps, validation and de-duplication of AI suggestions, learned variants, the post-transcription auto-fix, owner corrections and name spellings reaching every recap call, and the names/corrections API; the leveling filters are run through real FFmpeg (a 19 dB loudness gap between speakers drops to about 3 dB). A live GPT-5.4 name check on a fixture transcript found "Lonely Wood" → Lostleton and "Arakokra" → Aarakocra, and the regenerated recap used the corrected names and the owner's correction. Hosting tests cover exact host/origin, HSTS, `__Host-` cookies, trusted-proxy client resolution and spoofing, email+client lockout, invite-only signup, the pending-queue cap, retention expiry/purge, the instance lock, backups, operator links, chunked/resumable uploads and per-user quotas. The hosted deployment passed a real end-to-end run with its managed identity: invitation sign-up, chunked Opus upload, Speech diarization over the private Blob endpoint, YAMNet in the container, a GPT-5.4 recap, waveform, clip export, ranged playback, and session deletion with cloud cleanup. In-flight processing survived three rolling deploys. Account tests cover cookies/CSRF, bounded password hashing, generic failures and durable throttling, pending gates, one-use/expired/bound invitations and resets, password replacement/revocation, suspension, restart durability, and ownership on every session surface including ranged GET/HEAD audio. The earlier live synthetic Azure pipeline also completed successfully; its test session was subsequently removed at the owner's request. Opus coverage includes real stereo Ogg Opus decoding into 16 kHz mono MP3, codec/container validation, rejection before cloud upload of an MP3 renamed to `.opus`, and cleanup. Playback/review coverage includes session/entry deletion, legacy retention migration, validated edits, retained stale recaps, failed/successful regeneration, and corrected/empty exports. Two roughly two-hour reference sessions also completed the scene-extraction and narrative-writing pipeline on GPT-5.4, with no model-generated paragraph references. Manual comparison found substantially better concrete story coverage, including the endings; the prose remains more detailed than the human examples and still requires review for transcription ambiguities and attribution. Broad recognition accuracy, overlapping-speech accuracy, and sustained shared-plan load remain unverified.

Recap browser checks used an isolated fictional fixture, not real account data: citation-free prose rendering, collapsed recording navigation, paused seeking to the expected timestamp without leaving the recap, clip-editor opening with bounded defaults, and a 390-pixel layout without horizontal overflow.

Redesign browser checks covered library filtering/navigation, saved text/speaker changes and entry deletion, retained dirty recaps and Markdown exports, disabled account/admin/lifecycle previews, Escape/focus behavior, light/dark appearance, and layouts at 390, 1280, and 2560 pixels with no horizontal overflow. Upload failure/success and multipart fields were checked with intercepted requests, not additional billable Azure submissions. A silent MP3 fixture verified paused timestamp navigation and playback-position preservation across library/search/preview navigation.

Account browser checks used a separate temporary SQLite installation: real sign-in/sign-out, whitelist invitation acceptance, pending signup/manual approval, password-reset redemption and new-password login, per-user library isolation, whitelist removal, fragment scrubbing on initial and same-page navigation, and cross-tab clearing of private drafts/media/exports. Authenticated mocked uploads preserved all multipart fields and the exact CSRF token. Real application data and administrator passwords were not used for these checks.

## Costs and privacy

Costs comprise Speech audio hours, OpenAI input/output tokens (including chunk consolidation), temporary Blob Storage, and eventually hosting. Use your selected region's current [Speech pricing](https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/) and [Azure OpenAI pricing](https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/); there is no hardcoded dollar estimate or app billing cap. Establish Azure budgets/alerts and app-side limits before opening access.

Recordings go to the configured Azure Speech service via private Blob Storage. Transcript + optional campaign context go to the configured Azure OpenAI deployment. These are the intended processing destinations for real uploads. The app has no analytics and sends nothing from fictional demo mode. Review Azure data-processing/retention terms and your region requirements with the group.
