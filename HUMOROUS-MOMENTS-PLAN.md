# Humorous Moments Detection and Azure Worker Plan

> **Status (October 2026):** Hosting, 30-day retention, quotas and the hardening below are implemented. See [README.md](README.md#hosting-on-azure) for the deployed design (one Azure Container Apps replica, SQLite and recordings on an Azure Files share, managed identity for AI, manual deploys) and [SECURITY-REVIEW.md](SECURITY-REVIEW.md). Sections below that describe previews, a separate worker fleet, or App Service hosting are historical planning notes.


## 1. Decision summary

Add a **Humorous moments** feature that detects laughter in session audio, associates each
reaction with nearby transcript evidence, and gives the user timestamp buttons that seek to the
setup before the reaction.

Use:

- **YAMNet** as the initial audio-event model.
- **Azure App Service** for the authenticated web application and API.
- **Azure Container Apps Jobs on the Consumption workload profile** for finite audio-processing
  work.
- **Azure Storage Queue** to trigger jobs and absorb the initial backlog.
- **Azure Blob Storage** for private source recordings, temporary Speech inputs, and optional raw
  detector artifacts.
- The application's durable database for authoritative job and humorous-moment state.
- Managed identities for Azure resource access.

This is the preferred design for one user with approximately 50 sessions to process initially and
about one new session per week afterward. Container Apps Jobs can process the backlog with limited
parallelism and then scale to zero between weekly sessions. A GPU is not justified for YAMNet.

YAMNet has no per-minute model fee, but its execution still consumes Azure compute. See:

- [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)
- [Azure Container Apps Jobs](https://learn.microsoft.com/azure/container-apps/jobs)
- [Event-driven Container Apps Jobs](https://learn.microsoft.com/azure/container-apps/tutorial-event-driven-jobs)
- [Container Apps workload profiles](https://learn.microsoft.com/azure/container-apps/workload-profiles-overview)

## 2. User outcome

After a recording is processed, the session workspace shows a ranked **Humorous moments** list:

```text
Humorous moments

01:14:22  Strong reaction
"I cast Speak with Animals on the tax collector."

01:47:09  Brief reaction
"No, the mimic is legally our landlord now."
```

Selecting a moment seeks playback to a configurable lead-in, initially 10 seconds before the
detected laughter rather than to the middle of the reaction. The user can:

- Play the setup and reaction.
- Jump to the associated transcript entries.
- Confirm a useful moment.
- Dismiss a false positive.
- Restore a dismissed moment.
- Export confirmed and undismissed moments with timestamps and transcript evidence.

The UI must describe these as **likely humorous moments**, not as objective judgments about whether
the dialogue is funny.

## 3. Scope

### In scope

- Detect laughter and closely related laughter classes in uploaded recordings.
- Produce timestamped, confidence-scored events.
- Merge adjacent model frames into useful reaction intervals.
- Associate reactions with overlapping and preceding transcript entries.
- Rank likely humorous moments.
- Display, seek, confirm, dismiss, restore, and export moments.
- Process existing eligible recordings without retranscribing them when the retained original is
  still available.
- Run the detector in Azure-hosted background compute.
- Preserve sufficient run metadata to reproduce and recalibrate results.

### Out of scope for the first release

- Identifying who laughed.
- Claiming that every joke caused laughter or that every laugh indicates humor.
- Training a custom model before real-session evaluation.
- GPU inference.
- Live detection during recording.
- Using facial/video signals.
- Automatically editing highlight reels.
- Letting an LLM invent humorous events that have no timestamped audio or transcript evidence.

## 4. Why Azure Container Apps Jobs

The detector is a finite, containerized batch task with native dependencies, variable duration, and
long idle periods. An event-driven Container Apps Job is a better fit than running analysis inside
an HTTP request or the App Service web process.

### Recommended service split

| Responsibility | Azure service |
| --- | --- |
| Browser UI and authenticated API | App Service |
| Original and temporary audio | Blob Storage |
| Work dispatch and retry handoff | Storage Queue |
| FFmpeg, YAMNet, Speech submission/result processing | Container Apps Job |
| Container images | Azure Container Registry |
| Session, job, event, and feedback records | Durable application database |
| Secrets that cannot use managed identity | Key Vault |
| Logs, metrics, traces, and alerts | Application Insights / Log Analytics |

### Why not run YAMNet in App Service

- CPU-heavy work can make the web UI and API unresponsive.
- Deployments, restarts, and scale operations can interrupt in-process work.
- Local App Service files are not an authoritative job store.
- Native FFmpeg and model dependencies are easier to pin in a worker image.
- Queue-triggered workers provide bounded concurrency and explicit retries.

### Why not use Azure Functions as the primary detector

Functions can be made to work, especially with Durable Functions, but this workload already needs a
custom image, FFmpeg, a model runtime, large recordings, and finite batch execution. Container Apps
Jobs express that lifecycle directly and avoid adapting the detector to function invocation and
timeout conventions.

### Why not use Azure Batch or a GPU

Azure Batch is unnecessary operational complexity for roughly 50 initial items and one item per
week. YAMNet is a small CPU model; GPU startup and allocation would cost more and add regional
capacity dependencies without a meaningful user benefit at this scale.

## 5. Target architecture

```text
Authenticated browser
        |
        | create session / request upload
        v
Azure App Service API
        |
        | short-lived, owner-scoped upload grant
        v
Private original-recording Blob
        |
        | durable session + processing record
        | queue message containing opaque job ID
        v
Azure Storage Queue
        |
        | managed-identity KEDA trigger
        v
Azure Container Apps Job
  1. claim work idempotently
  2. stream/download recording
  3. inspect with ffprobe
  4. decode mono 16 kHz audio for YAMNet
  5. normalize and upload private Speech input
  6. submit Azure Speech batch transcription when needed
  7. persist detector results and processing state
  8. exit while Speech is running
        |
        | follow-up queue message
        v
Azure Container Apps Job
  9. poll Speech status without holding compute while waiting
 10. parse transcript
 11. associate laughter with transcript evidence
 12. generate recap and optional evidence-grounded moment labels
 13. clean temporary artifacts
 14. mark session ready
        |
        v
App Service API -> browser review
```

Do not leave a Container Apps Job running for hours solely to poll Azure Speech every 15 seconds.
Persist the Speech job URL and a next-check time, then enqueue a follow-up message. A worker that
finds Speech still running records the status and schedules another bounded check.

## 6. Model and inference design

### 6.1 Reference model

Use the official Apache-2.0-licensed YAMNet model and preserve its attribution and version in the
worker image and third-party notices.

The initial relevant labels are:

- Laughter
- Baby laughter
- Giggle
- Snicker
- Belly laugh
- Chuckle, chortle

Treat baby laughter as disabled by default for this application unless evaluation shows it catches
real reactions without introducing false positives.

### 6.2 Runtime choice

Use a two-stage implementation decision:

1. Build an offline evaluation harness against the official TensorFlow YAMNet implementation.
2. Prefer ONNX Runtime CPU in the production worker if a pinned conversion passes numerical and
   event-level parity tests against the reference implementation.

ONNX Runtime provides a smaller production dependency and faster container startup than full
TensorFlow. Do not accept a third-party converted model without verifying its source, license,
input normalization, class map, and output parity. If conversion parity is not demonstrated, ship
the official TensorFlow runtime in the worker image instead; correctness is more important than
image size.

Package the model and class map in the immutable image. Production processing must not download
model files from the public internet at runtime.

### 6.3 Audio preparation

- Use FFmpeg from the pinned worker image.
- Decode to mono, 16 kHz floating-point samples expected by YAMNet.
- Stream decoded PCM into inference where practical rather than writing a multi-hour uncompressed
  WAV.
- Preserve the original session clock from sample zero.
- Keep Azure Speech normalization behavior independent from detector input requirements.
- Reject unsupported, corrupt, oversized, or over-duration recordings before model execution using
  the same authoritative limits as transcription.
- Clean ephemeral files in success, failure, retry, and cancellation paths.

### 6.4 Event construction

Store raw model frame scores only as an optional diagnostic artifact with short retention. Persist
the resulting event intervals and run parameters as authoritative application data.

Initial event construction:

1. Combine enabled laughter-class scores per model frame.
2. Apply temporal smoothing over neighboring frames.
3. Start an event only after a configurable high threshold is crossed.
4. Continue it with a lower configurable threshold to avoid fragmented events.
5. Merge events separated by a short configurable gap.
6. Reject events below a minimum duration unless their confidence is exceptionally high.
7. Add small start/end padding without creating negative or post-duration timestamps.
8. Calculate peak time, peak score, mean score, duration, and contributing labels.

Thresholds must be configuration with a recorded detector-profile version, not unexplained constants
scattered through application code. Establish defaults from the evaluation set rather than guessing
them from one recording.

### 6.5 Humorous-moment ranking

The first ranking score should be deterministic and explainable:

- peak laughter confidence;
- sustained laughter duration;
- multiple nearby laughter bursts;
- penalty for isolated very short detections; and
- penalty for known confounders found during evaluation.

Associate each reaction with:

- transcript entries overlapping the event;
- the last complete transcript entries before the event, up to a bounded time/token window; and
- the first entry after the event when it helps explain a delayed reaction.

The displayed timestamp should normally be the start of the setup window, while the stored event
retains the exact laughter interval and peak.

An optional later Azure OpenAI pass may generate a short label or improve ranking from the bounded
transcript context. It must:

- cite stored transcript segment IDs;
- never create a moment without an underlying detector event in the first release;
- never alter event timing;
- be replaceable and clearly marked as generated; and
- fail independently without hiding detector results.

## 7. Data contract

Add a separate event type instead of representing laughter as a speaker transcript segment:

```ts
type HumorEvent = {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  peakMs: number;
  peakConfidence: number;
  meanConfidence: number;
  labels: Array<{ name: string; peakConfidence: number }>;
  contextSegmentIds: string[];
  rankScore: number;
  state: "suggested" | "confirmed" | "dismissed";
  detectorRunId: string;
};

type DetectorRun = {
  id: string;
  sessionId: string;
  modelName: "yamnet";
  modelVersion: string;
  runtime: "tensorflow" | "onnx";
  detectorProfileVersion: string;
  startedAt: string;
  completedAt?: string;
  status: "queued" | "running" | "completed" | "failed";
  errorCode?: string;
};
```

Requirements:

- Enforce `0 <= startMs <= peakMs <= endMs <= recording duration`.
- Use stable event IDs within one detector run.
- Preserve user confirmations and dismissals when rerunning the same detector profile by matching
  overlapping events conservatively; show unresolved changes for review.
- Never overwrite a successful prior run with a failed rerun.
- Store structured error codes plus sanitized user-facing messages.
- Keep model/profile metadata in exports for reproducibility.

## 8. Queue and job reliability

### Queue message

Messages contain only opaque identifiers and operation type, not transcript or recording content:

```json
{
  "schemaVersion": 1,
  "operation": "analyze-recording",
  "jobId": "uuid",
  "attemptId": "uuid"
}
```

### Processing rules

- The database is authoritative; the queue is a delivery mechanism.
- Claim work using an atomic state transition or lease.
- Make each stage idempotent.
- Use visibility timeouts renewed by the worker while it owns a message.
- Delete a message only after the durable stage transition succeeds.
- Use bounded retries for transient failures.
- Send permanently failing or retry-exhausted messages to a poison/dead-letter queue.
- Expose retry to the user without creating duplicate Speech jobs or detector runs.
- Record checkpoints around external side effects, especially Speech submission.
- Reconcile jobs left in running state after container termination.
- Support cancellation between stages and during inference where practical.

Do not rely only on Container Apps execution retries; application-level idempotency is required
because a container can fail after an external operation succeeds but before state is saved.

## 9. Azure sizing and scaling

### Initial worker sizing

Start with:

- Container Apps Consumption workload profile.
- CPU-only Linux container.
- 2 vCPU and 4 GiB memory per execution.
- One recording per job replica.
- Maximum two concurrent executions during backlog processing.
- Maximum one concurrent execution after the backlog is cleared, unless observed latency warrants
  two.
- A job timeout covering the measured worst-case preprocessing/inference time with margin, not the
  full Azure Speech wait.
- At most two platform execution retries, backed by application retry accounting.

Consumption supports scale-to-zero and currently allows configurations up to 4 vCPU and 8 GiB per
app/job. Confirm the selected region's available workload profiles during provisioning rather than
assuming every profile is present.

### Backlog behavior

- Queue the approximately 50 sessions in the order the user requests them.
- Show each session's queue position approximately; do not promise an exact start time.
- Default to two workers to shorten the backlog without overwhelming Speech quotas or Blob
  bandwidth.
- Allow an administrator to pause new claims while preserving queued work.
- Monitor CPU, memory, processing duration, failure rate, Speech throttling, and queue age.
- Increase CPU before increasing parallelism if single-session latency is poor.
- Increase parallelism only after observing Speech and storage behavior.

### Steady-state behavior

After the backlog, the worker should scale to zero. A weekly upload starts an execution from the
queue. Cold start is acceptable if job status immediately changes to Queued and the UI continues to
poll or receive status updates.

## 10. Security and privacy

- Keep original recordings and detector artifacts in private containers.
- Use short-lived, owner-scoped direct upload grants from the authenticated API.
- Use managed identities for Queue, Blob, database where supported, Speech, Key Vault, and registry
  access.
- Scope worker Blob permissions to the required containers.
- Do not put SAS URLs, access tokens, transcript text, or recording names in queue messages or logs.
- Disable public ingress on the worker; jobs do not expose an HTTP endpoint.
- Pin the base image, FFmpeg, model, runtime, and package versions.
- Scan worker images and rebuild for security updates.
- Record consent and apply the recording-retention policy to all derivative audio.
- Give raw detector-frame artifacts shorter retention than the original recording unless evaluation
  requires otherwise.
- Ensure session deletion removes or expires original audio, normalized audio, detector artifacts,
  and stored humorous events.
- Preserve sanitized operational metadata needed to prove deletion attempts and diagnose failures.

## 11. Observability

Emit structured telemetry without recording content:

- correlation ID, session ID, job ID, detector run ID;
- stage and state transition;
- queue wait and processing duration;
- recording duration and encoded byte size;
- inference real-time factor;
- number of raw and retained events;
- model/profile version;
- memory high-water mark;
- retry category and sanitized error code;
- Speech submission/poll duration; and
- cleanup outcome.

Create alerts for:

- oldest queue message age;
- poison queue depth;
- repeated worker crashes or out-of-memory exits;
- sessions stuck in one stage;
- high detector failure rate;
- Blob cleanup failure;
- Speech throttling/failure spikes; and
- App Service or worker authentication failures.

Never emit transcript bodies, model input samples, SAS tokens, authorization headers, or raw model
arrays to normal logs.

## 12. User experience states

Display independent states for transcription, recap, and humorous-moment detection:

- Queued
- Preparing audio
- Detecting reactions
- Waiting for transcription
- Matching reactions to transcript
- Ready
- Ready with detection warning
- Detection failed; retry available

A detector failure must not discard or fail an otherwise successful transcript. The user should be
able to retry humorous-moment detection without retranscribing when the original recording remains
available.

During the backlog, the library should make completed sessions immediately reviewable while later
sessions remain queued.

## 13. Evaluation and calibration

Before enabling the feature by default:

1. Select 8-12 consented sessions representing different microphones, Discord processing, music,
   table noise, overlapping speech, and recording quality.
2. Have a reviewer mark laughter intervals and useful humorous moments without seeing model output.
3. Run the official YAMNet reference model and preserve frame scores for the evaluation set.
4. Measure event precision, recall, boundary error, and useful-moment precision.
5. Pay particular attention to coughs, excited speech, dice, applause, music, and clipping.
6. Choose thresholds that favor precision in the default UI.
7. Compare the proposed production runtime against TensorFlow reference output.
8. Test one maximum-duration recording for runtime, memory, temporary storage, and cancellation.
9. Process a small backlog before queuing all 50 sessions.

Initial release gates:

- At least 80% of displayed default-sensitivity suggestions are judged useful or genuine laughter
  on the evaluation set.
- No timestamp is outside the recording duration.
- No model/runtime parity difference changes retained events beyond documented tolerance.
- A failed or terminated detector job resumes or retries without duplicate durable events.
- The API remains responsive while two worker executions run.
- Maximum-duration processing remains within configured CPU, memory, disk, and timeout limits.

Recall is secondary for the default list. A shorter list of credible moments is a better experience
than many false positives. A future sensitivity control may expose more candidates.

## 14. Delivery phases

### Phase A: offline detector spike

- Build a deterministic FFmpeg-to-YAMNet evaluation command.
- Pin the official model and class map.
- Produce JSON frame scores and merged intervals.
- Add golden tests for timestamps, smoothing, merge behavior, and corrupt input.
- Evaluate TensorFlow and ONNX runtime parity.
- Run against short clips and at least one full-length recording.

Exit: select the production runtime and a provisional detector profile.

### Phase B: domain and local integration

- Add detector-run and humor-event schemas.
- Add event construction, ranking, transcript association, and export logic.
- Add a worker command with explicit exit codes.
- Preserve current transcript/recap behavior.
- Add UI states, moment cards, seek lead-in, confirm/dismiss/restore, and retry.
- Validate accessibility and keyboard operation.

Exit: the complete feature works against development storage with deterministic tests.

### Phase C: durable hosted processing foundation

- Implement private original-recording Blob storage.
- Replace local JSON authority with the selected durable database.
- Add Storage Queue and poison queue.
- Make processing stages idempotent and resumable.
- Change uploads to authenticated direct-to-Blob flow.
- Split Speech submission from status polling so workers do not idle.
- Add reconciliation and cancellation.

Exit: a terminated worker or web deployment cannot lose or duplicate accepted work.

### Phase D: Container Apps deployment

- Create Azure Container Registry.
- Build a pinned, non-root worker image with Node, FFmpeg, model, and selected runtime.
- Provision the Container Apps environment and event-driven Job.
- Configure managed identity and least-privilege RBAC.
- Configure queue scaling, resource limits, timeout, retries, and maximum executions.
- Add Application Insights / Log Analytics telemetry and alerts.
- Test private network and DNS paths to Storage, Speech, database, registry, and Key Vault.

Exit: a private Blob upload triggers processing and completes without App Service performing model
inference.

### Phase E: backlog rollout

- Process 3 representative sessions.
- Review event quality and operational telemetry.
- Tune the detector profile and freeze its version.
- Process 10 additional sessions with at most two concurrent workers.
- Review failures, queue age, Speech throttling, CPU, memory, and disk.
- Queue the remaining backlog only after the first 13 sessions meet quality and reliability gates.

Exit: all eligible backlog sessions reach a terminal state with failures visible and retryable.

### Phase F: steady-state operation

- Reduce maximum worker concurrency to one unless processing latency is unacceptable.
- Confirm scale-to-zero behavior.
- Review false-positive dismissals periodically.
- Recalibrate only through a new versioned detector profile.
- Keep the previous successful results available until a replacement run succeeds.

## 15. Testing strategy

### Unit tests

- Score combination and smoothing.
- Hysteresis thresholds.
- Interval merging, padding, minimum duration, and duration bounds.
- Ranking stability.
- Transcript context association at start/end boundaries and long silence.
- Schema validation and export formatting.
- Preservation of feedback across an overlapping rerun.

### Worker integration tests

- Supported MP3 and Ogg Opus.
- Corrupt and unsupported media.
- Maximum byte and duration limits.
- FFmpeg failure and timeout.
- Model load and inference failure.
- Cancellation and forced termination.
- Cleanup after success and every failure stage.
- Idempotent replay of the same queue message.
- Duplicate queue delivery during active processing.
- Poison queue behavior.

### Hosted end-to-end tests

- Browser upload through private Blob storage.
- Managed-identity-only worker access.
- Queue-triggered scale from zero.
- App Service deployment while a worker is running.
- Worker termination and reconciliation.
- Azure Speech still running across several poll cycles.
- Transcript and laughter completion in either order.
- Playback seeking and context links.
- Session deletion and retention cleanup.
- Two concurrent backlog jobs while the web API remains responsive.

## 16. Documentation changes required during implementation

- Update [README.md](README.md) from local-MVP instructions to the hosted topology when hosting is
  actually implemented.
- Update [PLAN.md](PLAN.md) to make Container Apps Jobs the selected durable worker rather than an
  undecided option.
- Update [PRODUCT-PLAN.md](PRODUCT-PLAN.md) with humorous-moment states, ownership, retention, and
  deletion behavior.
- Add deployment documentation for the worker image, queue, Container Apps Job, identity, RBAC,
  monitoring, rollback, and model attribution.
- Add an operator runbook for poison messages, stuck sessions, model rollback, and backlog pause.

## 17. Final recommendation

Use **Azure Container Apps Jobs on Consumption, triggered by Azure Storage Queue**, as the ideal
host for YAMNet and the rest of the finite audio-processing worker. Keep **Azure App Service** for
the responsive authenticated web application.

Start CPU-only at 2 vCPU / 4 GiB with two concurrent executions for the controlled backlog and one
for steady state. Package the model in the worker image, verify an ONNX runtime against the official
TensorFlow reference, and avoid holding compute while Azure Speech processes asynchronously.

This design prioritizes the user's experience and operational reliability while remaining
appropriately simple for one user and low steady-state volume.
