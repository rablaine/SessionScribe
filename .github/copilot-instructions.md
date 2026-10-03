# Copilot instructions: Session Scribe

Session Scribe is a private web app (Express 5 + TypeScript, plain browser JS, Python YAMNet detector) for
transcribing and recapping D&D session recordings with Azure AI Speech and Azure OpenAI. It is hosted on
**Azure Container Apps** for the owner and a few invited friends, who pay nothing; the owner pays the Azure bill.
The source is **public on GitHub**.

## Non-negotiable rules

1. **Never commit real Azure identifiers or personal data.** No subscription/tenant IDs, resource names, hostnames,
   object/client IDs, IP addresses, or email addresses in tracked files, tests, or commit messages. Use placeholders.
   Real values live only in gitignored files:
   - `infra/deploy.local.json`: deployment parameters, read by the scripts (copy from `infra/deploy.example.json`).
   - `.private/`: operator notes, including the full Azure inventory.
   - `.env`, `.secrets/`, `data/`: local development only.
2. **No automated deployment.** Do not add GitHub Actions, CI/CD, webhooks, or anything that builds or deploys on
   push. Deploy only when the owner explicitly asks, using `infra/deploy.ps1`.
3. **Exactly one replica.** SQLite and the in-process job queue assume a single writer. Never raise `maxReplicas`
   above 1, add a second app on the same share, or switch the accounts database to WAL on the network share.
4. **Keep the access model invitation-only.** `APP_OPEN_SIGNUP=false` in production. Every `/api` route must stay
   behind `accounts.requireActive` and, for sessions, behind the ownership check. Anything that costs Azure money
   must respect the per-user quotas (`accounts.consumeQuota`).
5. **Do not touch unrelated Azure resources.** The AI account is shared with other work. The old development
   storage gateway App Service, its shared plan, and the older Speech-input storage account must not be modified.
   `infra/provision.ps1` manages only the app's resource group (app subscription) and the storage resource group
   (storage subscription).

## Deploying (manual, on request only)

```powershell
npm run check; npm test; npm run build        # all must pass first
.\infra\deploy.ps1                            # builds in ACR from the working tree, rolls out a new revision
.\infra\deploy.ps1 -SkipBuild -Tag <tag>      # roll back/forward to an existing image tag
```

- The image is built remotely with `az acr build` (no local Docker needed). `.dockerignore` is an **allowlist**.
  New runtime files must be added to it explicitly; secrets and data must never be.
- Image tags are `<timestamp>-<git sha>[-dirty]`. Commit before deploying so the tag identifies the code.
- A rollout takes about 1 minute. The new replica logs `Waiting for the previous instance to release the data
  directory...` and then `Ready.`; that is the instance lock handing over, not an error. In-flight jobs resume.
- Verify after every deploy:
  ```powershell
  az containerapp revision list -g <rg> -n session-scribe --query "[?properties.active].{n:name,image:properties.template.containers[0].image,state:properties.runningState}" -o table
  az containerapp logs show -g <rg> -n session-scribe --tail 20
  curl.exe -s https://<app-host>/api/auth/session   # expect 200 JSON with "setupRequired":false
  ```
- `infra/provision.ps1` is idempotent infrastructure setup. Re-run it only when infrastructure changes.
  - Storage subscription: storage account, SMB share, `speech-input` container, lifecycle rule.
  - App subscription: ACR, Log Analytics, managed identity and roles, the no-VNet Container Apps environment
    and its share mount.
  - Both: budget alerts.
- App settings (environment variables) and the storage-key secret are defined in `infra/deploy.ps1`.
- The Azure CLI must be signed in to **both** tenants, because the storage subscription is in a different tenant.
  Use `az login --tenant <id>` for each; logins accumulate.

## Production architecture (keep these invariants)

The app is split across two subscriptions **on purpose, to minimize cost**:

- **App subscription** (the AI account's subscription, where storage-key policies apply): one Container Apps replica
  (Consumption, 1 vCPU / 2 GiB) in a **no-VNet** Consumption environment, which has no load balancer, private
  endpoint or NAT charges. HTTPS ingress, `allowInsecure: false`. It also holds ACR (Basic) and Log Analytics.
- **Storage subscription** (a personal Visual Studio subscription in another tenant, without the key-blocking
  policy): one Standard_LRS storage account with:
  - the SMB share mounted at `/data` (account key in the Container Apps environment storage definition);
  - the `speech-input` blob container (temporary mono audio, 3-day lifecycle delete).
- The previous design (VNet, private endpoints, premium NFS) cost $60–80/month because the app subscription's
  policy force-disables shared-key access. **Do not move storage back into the app subscription** without
  re-reading that trade-off.

Invariants:
- `SQLITE_JOURNAL_MODE=DELETE` and SMB `mountOptions` with `nobrl` (in `deploy.ps1`). Never WAL on the share.
- `TRUST_PROXY=1`. Container Apps ingress appends the real client IP as the **last** `X-Forwarded-For` entry,
  verified in production with `LOG_FORWARDING=true`. Other values resolve to the ingress pod, not the client.
- Speech/OpenAI use the user-assigned managed identity (`AZURE_AUTH_MODE=managed-identity`).
- `AZURE_STORAGE_ACCOUNT_KEY` (a Container Apps secret, `secretRef`) is used to upload temporary audio and to
  sign a **48-hour, read-only, HTTPS-only, single-blob SAS** that Speech reads (Speech cannot authenticate into
  the other tenant). The SAS is never persisted or sent to browsers. Never commit or print the key.
- `AZURE_STORAGE_GATEWAY_*` stays blank in production.
- The container starts as root only to fix `/data` ownership (`docker-entrypoint.sh`), then drops to `node` via
  `setpriv`. Shell scripts must keep LF line endings (`.gitattributes`; the Dockerfile also strips CRs).
- Region: South Central US for the app environment and the storage account (next to the AI account). Container
  Apps environment creation failed in Central US for capacity reasons.
## Operating the hosted app

Account administration runs inside the container as the app user and prints one-use links. Never pass passwords
on a command line.

```powershell
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin reset-link --email <user>"
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin invite --email <friend>"
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin open-invite"   # not bound to an email
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin bootstrap-link --email <admin>"   # only when no admin exists
az containerapp exec -g <rg> -n session-scribe --command "scribe-admin delete-user --email <user>"
```

`az containerapp exec` gotchas:
- The command is sent in a URL, so `%`, `&`, `+`, `#` and quotes break or are mangled. Spaces are fine.
- Inside `sh -c`, use `${IFS}` instead of spaces.
- Sessions are rate-limited (HTTP 429). Space calls about 20 seconds apart.
- Do not try to transfer files through `exec`.

Rotate the storage key (only after suspected exposure; causes a short outage):
1. `az storage account keys renew` for `primary` and `secondary` in the storage subscription.
2. `.\infra\provision.ps1`, which re-sets the environment's SMB mount key.
3. `.\infra\deploy.ps1 -SkipBuild -Tag <current tag>`, which updates the app secret.
4. `az containerapp revision restart`.

Never put the key on a command line that the CLI might echo. Read it inside scripts, as `provision.ps1` and
`deploy.ps1` do.

Restore the accounts database from a daily backup:
1. Copy the backup into place: `cp /data/backups/accounts-YYYY-MM-DD.sqlite /data/restore-accounts.sqlite`.
2. Restart the active revision. On startup, the app swaps the file in once.

Logs: `az containerapp logs show` (live), or query `ContainerAppConsoleLogs_CL` in the Log Analytics workspace.
`az acr build` log streaming crashes on non-UTF-8 Windows consoles. `deploy.ps1` therefore queues the build with
`--no-logs`, polls it, and downloads the log via `listLogSasUrl` on failure. Keep it that way.

## Development and testing

- Node 22.13+ (developed on 24), Python 3.11 venv in `.venv` for the detector, and FFmpeg/ffprobe on `PATH`.
- `npm run check`, `npm test` (node:test via tsx; uses real FFmpeg), `npm run build`, and
  `.\.venv\Scripts\python.exe -m unittest discover -s detector -p "test_*.py"`.
- Local runs are localhost-only (`APP_PUBLIC_ORIGIN` blank). A non-loopback `HOST` requires `APP_PUBLIC_ORIGIN`.
- Add tests for every security-relevant change. `tests/hosting.test.ts` covers the public-hosting controls.
- The VS Code embedded browser cannot decode Ogg Opus. Test Opus playback in Chrome.

## Git hygiene (the repository is public)

- Author commits with the owner's GitHub no-reply address (already set in this repository's git config).
- Push only `main` to `origin`. Never use `git push --mirror` or `--all`.
- Before every push, confirm no real identifiers are tracked. Run `git grep -n -I -E "<pattern>"` with the real
  names from `infra/deploy.local.json` / `.private/`, and check `git ls-files` for anything under `.env`,
  `.secrets/`, `data/`, `.private/` or `infra/*.local.*`.
- `package-lock.json` must resolve from `https://registry.npmjs.org/`. On a machine with a private npm mirror,
  rewrite any `resolved` URLs back to the public registry before committing.

## Security documentation

[SECURITY-REVIEW.md](../SECURITY-REVIEW.md) is the living security record. When a change affects authentication,
quotas, storage, networking or deployment, update it, and run a security review before deploying.
