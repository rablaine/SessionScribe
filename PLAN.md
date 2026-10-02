# D&D Session Scribe: delivery plan

> **Status (October 2026):** Hosting, 30-day retention, quotas and the hardening below are implemented. See [README.md](README.md#hosting-on-azure) for the deployed design (one Azure Container Apps replica, NFS-backed `DATA_DIR`, managed identity, manual deploys) and [SECURITY-REVIEW.md](SECURITY-REVIEW.md). Sections below that describe previews, a separate worker fleet, or SMB/App Service hosting are historical planning notes.


## Recommendation

Use **Azure Speech batch diarization + Azure OpenAI recap generation** for existing recordings, and capture **separate Discord-user audio streams** in Phase 2. Keep the transcript as the system of record; make recaps replaceable, evidence-grounded drafts.

Phase 1 is a tractable small app. Reliable speaker identity in a mixed recording is the difficult part, not upload or summarization. Phase 2 is feasible but needs a voice-library compatibility spike and proper streaming/time alignment, not just "have the bot join."

## Feasibility and limits

| Requirement | Feasible? | Important qualification |
| --- | --- | --- |
| Transcribe existing MP3 and Ogg Opus recordings | Yes | `.mp3`, `.opus`, and `.ogg` (Opus only) inputs are validated and normalized to mono MP3. Speech recognition quality depends on sound quality, language, noise, and names. |
| Speaker-labelled phrases + timestamps | Yes | Diarization gives anonymous labels, not names. Users must review/rename labels. |
| Automatically identify which player is speaking from mixed MP3 | Not reliably | No enrollment/identity data. Character voices and shared microphones confuse labels. |
| Perfect overlap attribution / recover inaudible speech | No | Multiple voices already mixed into one channel can be irrecoverable. |
| Useful D&D recap | Yes | Ground in transcript evidence; distinguish intent, outcome, table talk, and uncertainty. Review required. |
| Transcribe a 3-4 hour session | Yes | Batch diarization limit is 240 minutes per file; mono required. |
| Arbitrarily long recording with stable speaker IDs | Not in this MVP | Split audio and reconcile labels across parts, or use separate source tracks. Naive chunking resets speaker IDs. |
| Discord-user speaker attribution | Yes, conditional | Receive streams can be mapped to Discord user IDs. This identifies the account/mic, not a character or people sharing a mic. |
| Bot voice receive with stable official guarantees | No | Current community library receive is explicitly undocumented by Discord. Test against current DAVE/E2EE support. |
| Upload a recording and instantly get a guaranteed recap | No | Batch service queue latency and model inference vary. Use durable asynchronous jobs. |

### Verified provider constraints

- Speech batch supports MP3, asynchronous jobs, phrase speaker labels/timing, and diarization up to **240 minutes**. Multi-speaker batch diarization requires a **mono** input.
- For the configured **2025-10-15** batch API, the request contract is `properties.diarization = { enabled: true, maxSpeakers: job.maxSpeakers }`. The generated REST `DiarizationProperties` schema confirms these fields. Legacy `diarizationEnabled` plus nested `diarization.speakers` was silently ignored in a live submission, with diarization omitted from its response and all phrases labelled Unknown. The corrected contract is covered by provider/domain tests and a completed live synthetic two-voice diarization/transcript/recap run. Human long-recording quality remains unverified.
- The current fast-transcription guide/quotas list up to **5 hours / 500 MB**, while the REST reference still lists **2 hours / 250 MB**. Documentation is inconsistent. We do not depend on those changing limits; this MVP uses the better-documented batch diarization limit. Fast transcription is a future optional short-recording lane after a regional live probe.
- Azure OpenAI v1 chat completions removes the dated API-version parameter. A deployment supporting JSON-mode chat completions is required.
- Current `@discordjs/voice` source maps SSRC to `user_id` and supports DAVE via `@snazzah/davey`. The library still warns audio receive is not documented by Discord. Some outdated search results claim no DAVE receive support exists; current upstream source contradicts that blanket claim. Re-check the pinned released version at implementation time, not just the main branch.

Sources:

- [Speech batch configuration and diarization](https://learn.microsoft.com/azure/ai-services/speech-service/batch-transcription-create)
- [Speech 2025-10-15 submit REST reference: DiarizationProperties](https://learn.microsoft.com/rest/api/speechtotext/transcriptions/submit?view=rest-speechtotext-2025-10-15#diarizationproperties)
- [Speech limits](https://learn.microsoft.com/azure/ai-services/speech-service/speech-services-quotas-and-limits)
- [Batch output format](https://learn.microsoft.com/azure/ai-services/speech-service/batch-transcription-get)
- [Fast transcription guide](https://learn.microsoft.com/azure/ai-services/speech-service/fast-transcription-create)
- [Fast transcription REST reference](https://learn.microsoft.com/rest/api/speechtotext/transcriptions/transcribe?view=rest-speechtotext-2025-10-15)
- [Azure OpenAI v1](https://learn.microsoft.com/azure/foundry/openai/api-version-lifecycle)
- [Discord voice protocol](https://docs.discord.com/developers/topics/voice-connections)
- [Current voice library capabilities and DAVE dependency](https://github.com/discordjs/discord.js/blob/main/packages/voice/README.md)
- [Receiver speaker mapping](https://github.com/discordjs/discord.js/blob/main/packages/voice/src/receive/VoiceReceiver.ts)

## Phase 1A: local MVP (implemented)

```text
Browser MP3 / Ogg Opus upload + consent + language/speaker settings
    -> Node/Express server -> durable local job JSON + sequential worker
    -> ffprobe validation: actual MP3 or Ogg Opus container/codec, <= 4 hours
    -> FFmpeg mixdown to mono MP3 (16 kHz / 64 kbps)
    -> private Azure Blob Storage, app SP/MSI direct upload
       OR certificate-authenticated narrow gateway -> gateway managed-identity upload
    -> Speech resource managed identity reads plain blob URLs
    -> Azure Speech 2025-10-15 batch job: diarization.enabled=true,
       diarization.maxSpeakers=job.maxSpeakers, timestamps, punctuation
    -> normalize into { id, speaker, startMs, endMs, text, confidence }
    -> save transcript independent of recap
    -> Azure OpenAI chunk notes -> hierarchical consolidation
    -> validated evidence IDs + reviewable recap
    -> browser speaker review / search / downloads
    -> delete temporary audio and cloud transcription
```

Why this stack:

- TypeScript/Node keeps the future Discord bot in the same ecosystem.
- Plain browser JavaScript/CSS is enough for the MVP; no unnecessary frontend bundler or framework.
- Speech batch avoids short-file model upload constraints and naive diarization chunking.
- Blob Storage and Azure AI endpoints are explicit. One Foundry account can supply both Speech and OpenAI APIs; a project alone does not automatically provide all the right endpoints.
- An optional separate Node storage gateway supports only `<job UUID>/mono.mp3` upload/delete and an authenticated container probe, with a 128 MiB streamed limit and two concurrent transfers per process. It does not expose the local UI or replace Speech's independent Blob reader identity/network path. See README for gateway API registration, caller claims, deployment environment, and compiled entrypoint.
- Provisioned gateway (**live synthetic pipeline verified**): a Linux App Service in Central US on an existing, approved shared plan (not scaled or otherwise changed). `NODE_OPTIONS=--max-old-space-size=128` bounds its V8 old-space heap, not total process memory. Shared capacity is not unlimited upload capacity; the private endpoint incurs an ongoing charge.
- The gateway's system-assigned managed identity has container-scoped Blob contributor. A dedicated VNet provides a delegated App Service integration subnet and a private-endpoint subnet holding the Blob private endpoint, with private DNS `privatelink.blob.core.windows.net`.
- A dedicated gateway API app registration (`appRoleAssignmentRequired=true`) with the `Audio.Manage` application role authorizes only the existing local certificate service principal (exact client ID and object ID). Real identifiers live in private configuration, not this repository.
- Deployment is restricted to the four compiled gateway modules (`gateway-server`, `gateway`, `gateway-storage`, `storage-contract`), root package manifests/lockfile, and production dependencies; startup is `node dist/gateway-server.js`. The manual helper [infra\deploy-gateway.ps1](infra/deploy-gateway.ps1) builds the modules, runs `npm ci --omit=dev`, and ZIP-deploys the package. Certificates, `.env`, local data, UI, and other app modules are excluded. Storage is restored to enforced `SecuredByPerimeter`, firewall Deny, anonymous/keys disabled. The Speech resource managed identity's container reader and NSP subscription allowance remain separate; gateway checks cannot establish that independent path or full pipeline readiness.
- Live verification passed anonymous/wrong-audience rejection (`401`), authorized app container health (`204`), and real Blob upload/delete via the private endpoint. Observed gateway idle working set was approximately 121 MiB with negligible CPU time, while the existing app remained Running with unchanged configuration; these observations are not load/capacity guarantees.
- **Full live synthetic pipeline completed:** a synthetic two-voice test processed 26.14 seconds into eight timestamped segments with anonymous labels `speaker-1`/`speaker-2` and a generated recap, with no warnings. Durable `job.json` retains the completed transcript/recap without cloud handles; local `original.mp3`/`mono.mp3` and the Speech job/private blob were successfully removed. The earlier interrupted recap resumed successfully after restart following the Windows persistence fix, and the superseded test was deleted through the API.
- Validation: **38 tests, typecheck, and build pass**. Storage remains enforced `SecuredByPerimeter`; the configured local frontend uses only the authenticated gateway's private Blob path. There is **no public friend-facing UI**. This validates synthetic audio and the integration/cleanup path, not human long-recording diarization/recognition/recap quality or sustained hosting capacity.
- Local filesystem storage makes setup small. It is intentionally replaceable before public hosting.

Acceptance criteria:

1. A consented MP3 or Ogg Opus recording produces a persisted transcript with chronological, speaker-labelled phrases and offsets relative to the original recording.
2. A multi-hour session is not silently truncated. Unsupported length produces a clear error.
3. Recap input covers the entire transcript; every recap fact has valid source IDs. No fabricated success when Azure fails.
4. Users can play retained recordings, seek from transcript/recap timestamps, correct phrase text/speaker assignments and label names, or delete individual entries. Recaps are retained with an out-of-date marker until successful regeneration; exports reflect saved corrections.
5. Recap failure preserves transcript and supports retry without retranscribing.
6. Restart resumes saved cloud jobs. Deletion/cleanup failures are surfaced.
7. Demo is explicitly fictional and incurs no cloud calls.

## Phase 1B: real-recording evaluation and quality

Start with a 5-10 minute clip, then one full session, after resource configuration.

- Create a small hand-labelled reference: player, start/end, exact words, 15-30 important session facts.
- Measure word error rate, fantasy-name accuracy, diarization error rate / speaker confusion, timestamp drift, recap factual precision and important-event recall.
- Suggested initial product targets, **not guarantees**: >= 95% recap factual precision on annotated events, >= 85% important-event recall, timestamps within 2 seconds on 95% of sampled phrases. Set speaker accuracy targets after observing your actual recordings.
- Require correct treatment of an interrupted action, failed dice roll, proposed future action, loot/XP not awarded, and similar-sounding character names.
- Improve recording quality first: headsets, separate tracks where possible, lower music, avoid heavy normalization/noise gates.
- Phrase text/speaker editing and playback with seek-to-evidence are implemented. Original recordings stay local until session deletion; normalized local audio and cloud artifacts remain temporary. Older deleted audio requires re-upload.
- Add segment split/merge, timestamp editing, speaker merge tools, and configurable retention policies after evaluating the current correction workflow.
- Evaluate custom Speech models for fantasy vocabulary or a current diarized transcription model. Verify regional availability, long-input constraints, timestamps, latency, and cost with real recordings before switching.
- Add recordings longer than four hours only with explicit cross-chunk speaker reconciliation or separate tracks; never imply label continuity from isolated diarization requests.

Indicative effort: local MVP, playback, and phrase correction UX are implemented; allow several days of real-recording evaluation and 1-2 weeks for advanced correction tools, depending on quality requirements.

## Phase 1C: public Azure hosting gate

Do **not** lift the localhost guard and ship this as-is.

Target:

```text
Authenticated browser
  -> direct private Blob upload (short-lived, tenant-scoped grant)
  -> App Service API
  -> durable queue / worker (Container Apps or Functions where suitable)
  -> Speech batch + Azure OpenAI
  -> Azure SQL/Cosmos metadata + private Blob artifacts
  -> authenticated session review / sharing
```

Before public access:

- Entra External ID or another explicit auth choice, owner/party authorization on every endpoint, invitation/share policy, tenant isolation, request CSRF protection.
- Upload byte/duration quotas, concurrency limits, per-user daily audio-hour/token budgets, rate limits, payment/abuse strategy. Azure budget alerts alone do not stop spending.
- Direct-to-Blob uploads; don't route 500 MB bodies through App Service's frontend/proxy. Avoid long work in HTTP request lifetimes.
- Durable workers with leases, idempotency/reconciliation, retry policy, cancellations, dead-letter handling, and restart/deploy recovery.
- Managed identity, Key Vault for unavoidable credentials, private network design, and permission-scoped access. Account keys are already removed; local development uses an app certificate, not the administrator's identity.
- Database/artifact retention policy, deletion of all cloud copies, encryption/access controls, backup handling, regional/privacy policy, recording consent and takedown process.
- Application Insights with sanitized logs (never transcript bodies or SAS/key credentials), job metrics, cost attribution, alerts.
- Container image with pinned FFmpeg/Node dependencies; health probes, deploy pipeline, staging, and load tests.
- Explicit host/origin allow-list replacing the local guard only after auth is in place.

App Service is good for the web API. A separate worker/container is better for audio normalization and durable processing. The Discord voice bot also belongs in a long-lived service supporting outbound UDP/WebSocket, not a short-lived serverless function. Indicative effort: 2-4 weeks for a real multi-user beta, longer for monetization/compliance requirements.

## Phase 2: Discord capture

### First: compatibility spike

Before promising users live capture, build a bot that:

1. Joins a private test voice channel with `selfDeaf: false`, using a bot account (never a user self-bot).
2. Uses a pinned released `discord.js` / `@discordjs/voice` / DAVE dependency combination on its required Node version.
3. Receives/decrypts 10 minutes of Opus from three users and records the user-ID mapping.
4. Survives DAVE rekeying, user joins/leaves, pauses, simultaneous speech, reconnects, and channel changes.
5. Stores consent/audit events and stops capture when required.

Pass this gate on the actual host/network before implementing transcription streaming. Main-branch documentation currently requires a newer Node 24 patch than this MVP's runtime; Phase 2 must use the version required by the pinned release.

### Capture design

- `/record start`, `/record stop`, `/record status`, configured channel/role permissions and explicit participant opt-in.
- Visible recording notice, no covert capture; reevaluate consent on joins and respect opt-outs.
- Opus receive per Discord user -> PCM decoding -> separate tracks and segment metadata.
- Store Discord user ID, display name snapshot, monotonic session offset, RTP sequence/timestamp, stream gaps, joins/leaves, and permission/consent state.
- Keep a common session clock. Sparse speech-only files lose silence; either preserve the timeline or retain segment-start offsets. Do not concatenate all utterances at offset zero.
- User streams provide speaker IDs directly. Transcribe per-user streams without acoustic diarization, then merge by session timestamp. Simultaneous speakers remain simultaneous.
- For initial Phase 2, capture live but run transcription/recap after stop. This reuses Phase 1's artifact and review model while reducing streaming complexity.
- For later live transcripts, use streaming Speech sessions per user, bounded buffers/backpressure, reconnection handling, partial-to-final updates, and session rollover at provider limits.
- Recap only final transcript segments after stop; live partials are unstable. Optionally generate provisional chapter summaries marked as such.
- Discord identity is the account/mic. A person playing several characters still needs explicit character metadata; shared microphones remain ambiguous.

Indicative effort: 2-3 days for the receive/DAVE spike, then 1-3 weeks for capture + post-session processing, additional time for polished live transcription/recovery. These are planning estimates, not delivery guarantees.

## Deferred on purpose

Campaign-wide memory, automatic NPC identity recognition, autonomous rules adjudication, polished narrative embellishment, perfect cross-session biometrics, public sharing without auth, and Discord capture without participant consent.

## Next milestone

Provision the three resources in [README.md](README.md), configure `.env`, and run a consented short clip. Only after that live check should we claim Azure end-to-end correctness or decide whether a different speech model is needed.
