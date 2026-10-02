# Session Scribe: application and access roadmap

## 1. Product direction

Build a working application for reviewing Dungeons & Dragons recordings, not a landing page.
The primary tasks are finding a session, listening to it, correcting its transcript and speakers,
and reading or exporting its recap. Establish hierarchy with layout, readable typography, and
clear actions before adding decorative styling. Do not put promotional hero content above the
workspace.

### User-system decisions

Following the redesign, the owner chose **SQLite through single-instance production**, rather
than a managed cloud database, and **administrator-issued single-use invitation/reset links**
shared directly rather than an email-delivery service. Ordinary signup remains pending until
manual approval; whitelisted addresses activate through a confidential bound invitation, never
by entering an email string alone. The five existing test sessions were authorized for removal.
Recording retention and public hosting are still separate delivery steps.

### Original redesign scope (completed)

- Redesign the real, functioning local session library and review workspace.
- Move importing into a dedicated dialog instead of making the upload form dominate every session.
- Keep working MP3/Opus uploads, transcription, polling, speaker names/assignments, phrase edits and
  deletions, stale-recap markers, regeneration, searching, exports, playback, and session deletion.
- Add clearly labeled UI frames for sign-in, requesting access, pending approval, administrator
  approvals/whitelisting, and recording availability/expiry.
- Do **not** implement accounts, passwords, approvals, per-user authorization, new cloud recording
  storage, retention jobs, public hosting, or Discord logic in this redesign.
- Preview controls must not create accounts, collect credentials, approve users, or imply that
  the local application is already secure or that its recordings already expire after 30 days.

This is a visual/information-architecture iteration on the existing Express and browser application,
not a framework migration. The existing localhost restriction, backend, credentials, private Azure
networking, and storage lifecycle remain unchanged.

## 2. Application structure

### Session library

- A compact application navigation area, an account area, and a session library as the default view.
- Real session titles, dates, status, search, and filters; make opening a recording the obvious action.
- A primary **Import session** action and a separate fictional demo action.
- Empty, loading, filtered-empty, and failed-load states with specific next actions.
- Once authentication exists, only the signed-in user's sessions load. A global local library is
  not evidence of user isolation.

### Session review

- A clear session heading, processing/error state, Transcript and Recap views, and export actions.
- A readable transcript with timestamp gutter, speaker identity, phrase text, and entry editing.
- An inspector for speaker names and recording availability instead of a large configuration block
  preceding the transcript.
- Editing supports text, reassignment to a known speaker, and deletion of a single speaker/phrase
  pair. Stable IDs, order, and original audio offsets remain unchanged for surviving entries.
- Keep the saved recap when the transcript or speaker names change. Persist an **Out of date**
  marker and a shortcut to regeneration. Successful regeneration replaces the recap and clears
  the marker; failures keep the previous recap. Deleted evidence references must be visibly
  unavailable, not silently linked to a different phrase.
- Retain TXT, transcript Markdown, SRT, JSON, and separate recap Markdown downloads.
- Center the pinned player and its title/position as one horizontal group, with an intrinsic-sized
  text column and a fixed gap. Widening the window must not create a growing blank text column.
- Preserve drafts and playback position through polling, searching, and ordinary renders.

### Import flow

1. Choose an MP3 or Ogg Opus recording.
2. Enter a session title, language, expected speaker count, and optional campaign spelling context.
3. Confirm recording/processing consent and review the applicable recording-retention policy.
4. Show upload progress/state without allowing dismissal to imply that the upload was canceled.
5. After server acceptance, open the new session and show durable processing stages.
6. On failure, preserve the form and explain what can be retried.

Keep the current 500 MiB / four-hour limits until capacity and billing controls are reassessed.
Do not let future approval-pending accounts bypass the import gate.

## 3. Password accounts and ownership

### Intended model

- Email and password sign-in; sign-up/request-access, sign-out, email verification, password reset,
  expired-session, invalid-credentials, pending-approval, rejected, and suspended-account states.
- Separate authentication, email ownership verification, access approval, and administrator role.
  Possession of an email string alone must not activate a whitelisted account.
- Suggested account states: `unverified`, `pending`, `active`, `rejected`, `suspended`.
- Normalize email addresses using an explicit case-insensitive application policy and enforce a
  unique canonical email in the database. Test normalization and duplicate-request behavior.
- A verified email on the whitelist becomes active immediately, without another manual approval.
- A verified email not on the whitelist remains pending and sees:
  **"Talk to the admin to enable access."**
- Pending accounts can view their account/access status, but cannot list, import, play, edit,
  regenerate, export, or delete session data.
- Identity is confirmed through personally shared, bound invitations or explicit manual approval.
  Password recovery uses administrator-issued one-use reset links; automated email is optional
  future work, not an activation dependency.

### Security requirements for the implementation phase

- Hash passwords with an established, appropriately configured password-hashing implementation
  such as Argon2id; never store plaintext passwords or ship an administrator password in source.
- Use revocable server-side sessions with Secure, HttpOnly, SameSite cookies, CSRF defenses,
  appropriate expiry, and rotation after authentication/privilege changes.
- Add login/signup/reset throttling, generic authentication failures, abuse limits, and audit events
  without logging passwords, reset tokens, recording content, or full authentication tokens.
- Invalidate sessions when an account is suspended or its access is revoked.
- Require server-side ownership and active-account checks on **every** job, audio, edit, speaker,
  recap, export, and deletion route. Hiding a button is not authorization.
- Return a non-enumerating not-found response for another user's session. Never trust a browser-
  supplied owner ID or blob path.
- Reassess CSP, origin checks, TLS, secret handling, deployment settings, and dependencies before
  enabling public hostnames. The current local-only controls are not a production account system.

### Durable data

Use SQLite for users, login sessions, access requests, whitelist records, token hashes, audit
events, and session ownership. Preserve the working local job JSON/media persistence for this
single-process application. Keep the whole data directory on persistent local storage and back
it up consistently. This is the explicitly selected production architecture for a very small
installation, not a planned migration to Azure SQL/PostgreSQL or a multi-replica deployment.

Suggested entities:

| Entity | Key responsibilities |
| --- | --- |
| User | Stable user ID, canonical/verified email, password hash, role, access state |
| Login session | Expiry, revocation, rotation, user association |
| Whitelist entry | Canonical email, creator, creation/removal timestamps |
| Access request | Applicant, pending/approved/rejected state, review actor and timestamps |
| Session/job | Owner ID, title, locale, transcript/recap revisions, processing state |
| Recording | Owner/job, private blob key, original name/type/size, upload/expiry times, availability |
| Audit event | Administrative and security actions, minimal non-content metadata |

Persist recap source revision versus current transcript revision when the database is introduced;
the existing boolean dirty marker is sufficient for the current local application.

## 4. Administrator and approval flow

- Configure the administrator identity server-side, preferably through an environment variable
  such as `APP_ADMIN_EMAIL`. This variable identifies the account; it does not contain its password
  and must not be interpreted by browser JavaScript as an authorization rule.
- Bootstrap the administrator through a controlled one-time setup/verified invitation. Prevent
  ordinary signup from claiming the administrator role merely by entering that email.
- Maintain the administrator role and approval state in durable server-owned records. Document how
  administrator-email configuration changes affect an existing account and avoid accidental lockout.
- The administrator can:
  - View pending requests with email, verification status, and request date.
  - Approve or reject a request.
  - Add/remove whitelist email addresses before those people request accounts.
  - Suspend/reactivate access under an explicit policy.
- Approval and whitelisting should be idempotent and audited. Approval must not lose a request that
  was reviewed concurrently or disappear on application restart.
- An approved user signs in or refreshes account status to enter their session library. Persist the
  state server-side; do not rely on a browser flag or a frontend whitelist.
- A pending request page should offer a status refresh and sign-out, not a fake "approval sent"
  success. The user already knows how to contact the administrator outside the application.
- Administrator access management does **not** automatically grant access to every user's recordings
  or transcripts. If support access is needed later, define consent, scope, and auditing separately.

Account administration is now server-backed. The earlier inert account/approval gallery has been
replaced by real, administrator-authorized controls. Recording-lifecycle illustrations remain
clearly labeled previews.

## 5. Private cloud recordings with approximately 30-day retention

### Keep two distinct audio lifecycles

| Audio category | Intended retention | Purpose |
| --- | --- | --- |
| Original user recording | 30 days from accepted upload, configurable | Playback and transcript correction |
| Normalized Speech processing source | Delete after processing; short lifecycle safety net | Batch transcription |
| Local worker/cache copies | Temporary, bounded, owner-scoped | Conversion, streaming, recovery |

**Current behavior is different:** originals remain on the local machine until session deletion.
The existing `dnd-audio` Azure container stores temporary normalized processing sources with a
three-day lifecycle safety net. Do not simply change that existing rule to 30 days and assume
original recordings have become durable cloud playback assets.

### Proposed implementation

- Create a separate private recordings container, for example `session-recordings`, rather than
  conflating originals with transient Speech inputs.
- Store original MP3/Opus bytes with correct content type and immutable internal keys containing
  owner/job IDs, not email addresses or untrusted filenames.
- Preserve SP/MSI authentication, disabled anonymous/shared-key access, enforced perimeter/private
  networking, and container-scoped least privilege. Prefer the hosted application's managed identity.
- The current gateway only uploads/deletes normalized MP3s and has a 128 MiB transfer ceiling.
  Original uploads can be 500 MiB, and authenticated playback requires range reads. Design and test
  the original-upload/playback path explicitly; it does not exist merely because the gateway does.
- Serve recording playback through the authenticated application or an equivalently owner-authorized
  streaming route. Support GET/HEAD and byte ranges without exposing the private storage account,
  minting long-lived public links, or forwarding AI bearer credentials to other services.
- Persist authoritative `uploadedAt`, `expiresAt`, and availability state on the server. Default
  expiry is accepted-upload time + 30 days; playback, transcript edits, and recap generation do not
  silently extend the recording's lifetime.
- Use a scoped Blob lifecycle rule plus a reconciliation/deletion worker. Azure lifecycle scans
  are asynchronous; they do not promise deletion at the exact expiry minute.
- At the application expiry boundary, stop offering playback and mark the recording expired even
  if physical deletion is still pending. Reconcile physical purge and surface operational failures.
- Manual session deletion removes its recording immediately where possible and surfaces failures;
  do not claim cloud deletion succeeded when it did not.
- Keep transcripts, speaker labels, and recaps after recording expiry until the user deletes the
  session. Revisit separate metadata retention/privacy rules before broader rollout.
- Re-upload should initially create a new session. Attaching a replacement recording to existing
  edited timestamps requires an explicit identity/duration/alignment policy; do not silently remap it.
- Plan migration of existing retained local originals. Audio already deleted by old versions cannot
  be recovered and requires a fresh upload.

### User-visible recording states

- **Available:** playback enabled, upload date and expiry date/days remaining displayed.
- **Expiring soon:** clear warning and an optional authenticated download before expiry.
- **Expired/purged:** "This recording was removed after 30 days. Your transcript and recap are
  still available." Disable playback without disabling transcript corrections or exports.
- **Unavailable/error:** distinguish missing/corrupt media, browser codec support, network failure,
  and actual policy expiry. An HTTP error is not proof that a recording was purged.
- **Legacy/no recording:** honestly explain that older local originals were deleted; do not invent
  a 30-day expiry date for them.

The available/expiring/purged designs are preview frames only in this iteration.

## 6. Delivery order and release gates

1. **Application redesign (this iteration):** real local workflows plus visibly inert future frames.
2. **Durable ownership model (implemented):** SQLite account/session/ownership records, per-user
   queries and authorization tests; existing test data removed rather than silently reassigned.
3. **Accounts and approval (implemented):** password accounts, trusted local administrator
   bootstrap, whitelist/invitation/request review, server-side sessions, one-use reset links,
   throttling, audit, suspension.
4. **Original cloud recording retention:** private original-upload/read path, 30-day policy,
   expiry/reconciliation, ranged playback, deletion, migration, user-visible lifecycle states.
5. **Friend-facing deployment:** authenticated HTTPS application, private network integration,
   production worker/queue, quotas/capacity, budgets, backup/restore and operational monitoring.
   Do not turn the existing application-only gateway into a public unauthenticated multi-user UI.
6. **Real-recording evaluation:** accuracy, overlapping voices, fantasy names, timestamp alignment,
   full-session duration, billing, and shared-hosting capacity.
7. **Discord phase:** consented live capture, platform/user speaker mapping, reconnect handling,
   and the same account ownership/retention boundaries.

## 7. Acceptance tests for later implementation

- Whitelisted verified users activate immediately; non-whitelisted users remain pending.
- Unverified users cannot impersonate a whitelisted or administrator email.
- Pending/rejected/suspended users cannot access session APIs through direct requests.
- Only an authorized administrator can review requests or change the whitelist.
- Approval, rejection, revocation, and whitelist changes survive restart and are audited.
- User A cannot discover/read/play/edit/export/delete User B's session, even with its ID/blob key.
- Imported recordings belong to the authenticated account, not a submitted owner field.
- Original audio stays usable within its 30-day window; editing does not renew expiry.
- Playback expires gracefully while transcripts/recaps/exports remain usable.
- Blob reconciliation, cloud deletion failures, ranged reads, browser codec errors, and legacy
  missing audio are tested independently.
- Dirty recaps are retained, their unavailable evidence is visible, and successful regeneration
  clears the marker without retranscribing.
- Drafts and playback position survive library filtering, polling, preview dialogs, and normal edits.
- Keyboard, narrow-screen, light/dark theme, modal focus, and reduced-motion behavior are verified.

## 8. Decisions to confirm before backend work

- Final administrator email and secure bootstrap process.
- Invitation/reset-link sharing process and rate limits; email delivery is not required.
- Single-instance hosting/worker capacity, persistent SQLite disk/backup operations, and deployment region.
- Exact default retention (proposed 30 days), expiry warning threshold, account storage/upload quotas,
  and whether users can download originals before expiry.
- Rejection/reapplication, suspension, administrator support access, and account deletion policies.
- Migration of local recordings and handling of duplicates/re-imports.

No credentials, resource mutations, or production access guarantees are part of this UI-only delivery.
