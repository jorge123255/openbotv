# Full instance migration and hosting choice

Status: staged design for George's fork, based on main `161f0a673e202db626cb2104d15e01e87afc3dea`.
Only the Docker backup source-stop option in stage 1 is implemented here. There is no full
cross-platform migration command, credential exporter, restore startup gate or cutover service.
Do not use the normal agent transfer as a complete migration.

The goal is to move the same agents, conversations, files, settings and account associations to a
chosen runtime: this Mac, another supported desktop, a Linux server, or Docker on a chosen host.
The client can then disconnect while that runtime continues to work. A local desktop runtime still
needs its computer awake. A Docker runtime on the Mac also stops when the Mac sleeps or shuts down.
The existing local child servers stop with the desktop; they are not an independent daemon.

"Everything" includes logins and tokens. Each item must be inventoried, transferred and verified,
or shown as a specific unresolved item. A fresh sign-in must retain the same account association
and agent history. It must not silently create a replacement agent. An incomplete move cannot be
reported as complete. A process, open socket, active turn or OS device cannot be copied as saved data.

## Existing paths and limits

[Self-hosted servers](../self-hosted-server.md) and [Docker](../docker.md) already run the Linux
Electron app without a physical screen. The current Compose files use the upstream image. Use an
exact compatible image built from this fork before moving fork data. This PR does not build, deploy,
change a release feed, or change the image reference.

The existing [agent transfer](agents.md#instance-transfer) creates agents with new IDs. It leaves
out chat history, shared tables, provider sessions, most secrets and host trust. Its import can
activate routines that were active on the source. Its file filters do not scan arbitrary workspace
contents for secrets. It is not a consistent database/filesystem snapshot.

The separate [Docker backup](../docker.md#backups) copies the whole `/data` recovery unit after a
container stop. It keeps original IDs, both databases, files, CLI homes, the Linux keyring and its
password. Its compressed archive is not encrypted. Verification checks archive hashes, required
file hashes, SQLite integrity, record counts and shared ownership warnings. It does not unlock a
keyring, decrypt credentials, verify every attachment reference or start OpenBot. Hash checks detect
accidental changes; they do not authenticate an untrusted archive and its hash file.

Docker restore verifies first and leaves the target stopped. Neither backup nor restore proves that
another copy with the same identity is off. `--keep-stopped` prevents the backup itself from starting
the source after its stop, including copy or verification failure. It checks the exit code only when
it performs the stop. An already stopped or removed container is accepted with unknown prior stop
state. It is not a persistent fence or proof of a clean, complete migration snapshot.

## Required inventory

Inventory must cover all roots before snapshot creation. Default CLI homes can be outside userData.
Record source/destination OS, architecture, exact fork build, schema version, runtime requirements,
each child server, file owner/mode, links, external mounts and path overrides. Preserve unknown files
as opaque data, mark their purpose unresolved, and block completion until their owner is understood.
Do not silently skip an unreadable, oversized or unsupported item.

| Data class | Source implementation and current limit | Required migration behavior |
| --- | --- | --- |
| Agent identity and history | `src/backend/openbot-database-schema.ts`; `openbot.db` includes projections and durable events | Keep agent/thread/message IDs, history, reactions, queue state and references together. Compare IDs and record counts, not only names. No profile recreation. |
| Attachments and files | `src/backend/workspace-paths.ts`, `src/main/session-configuration.ts`; workspaces, Shared/Transfers, avatars and stored browser/download data | Inventory bytes and every database reference. Hash all regular files and check missing/orphan references. Preserve Git data and files omitted by ordinary transfer. Never follow a link into an undeclared source root. |
| Shared tables | `OpenBot/Shared/Data/agent-data.db`; ordinary transfer excludes it | Snapshot with the main database. Preserve table ownership IDs and validate references. An existing orphan is reported separately from a new loss. |
| Skills and provider histories | `src/backend/agent/provider-accounts.ts`, `src/backend/provider-drivers.ts`; default CLI homes, additional `provider-accounts/<id>` and global skills | Include all accounts, histories and global dependencies. Snapshot each root once and retain account/session mapping. Inspect provider-specific absolute paths before any rewrite. |
| Routines and shared execution | `src/backend/routine-scheduler.ts`, routine flows and durable queues | Preserve IDs, schedule, timezone, policy, delivery cursor and paused/active intent. Rehearsal must suppress all execution without deleting schedule history. Review missed events before resume. |
| Host identity and trust | `src/main/team-store.ts`, central account and remote-server stores | Keep host ID, signing keys, members, sessions, invite state, pending rotation and pinned identities as one set. Do not register a competing host or reset client trust. |
| App settings and permissions | `src/main/application-services.ts`, `openbot-agent-access-v1.json`, approval automation and host-tool configuration | Preserve values, but review OS-specific tools, commands, paths, grants and displays before enabling them. A copied permission is not proof that a new host is trusted. |
| Extra local servers | `src/main/local-servers/local-servers.ts`; userData under `local-servers/<id>` and workspaces under `OpenBot/Servers/<id>` | Include each identity and its sealed registry password, plus shared CLI homes and skills. Do not merge child databases. |
| Active runtime state | Provider processes, browser processes, sockets and running turns | Quiesce and record interruption. Resume only a provider-supported saved session after checks. Never replay an uncertain tool action, approval, payment or message. |

## Credentials: preserve accounts without unsafe promises

`safeStorageCipher` in `src/main/application-services.ts` uses Electron's OS secret storage. A
copied encrypted file is not proof that another OS or user can decrypt it. Validate all required
secrets before normal startup. For example, `src/main/ingress-queue-key.ts` creates another key
when the saved key cannot be read. An ordinary startup could then lose access to pending sealed
events. Migration must stop before such fallback writes, retain original blobs and report a blocker.

| Credential class | Code evidence | Portability rule |
| --- | --- | --- |
| Provider API keys and custom endpoints | `src/main/provider-credential-store.ts`, `src/main/custom-provider-store.ts` | Export only through an approved source adapter. Re-encrypt with destination secret storage. Preserve endpoint/headers and account association; do not test a real key during rehearsal. |
| Account, host and joined-server sessions | `src/main/central-auth-manager.ts`, `src/main/remote-session-cache.ts`, `src/main/remote-server-stored-shape.ts`, team store | Preserve identity relationships. Server-side expiry, revocation, rotation and device rules can require sign-in. No automatic host registration or token refresh in rehearsal. |
| Grok Bot | `src/backend/grok-bot/grok-bot-account.ts`; access/refresh token, gateway headers/token and optional VNC credentials | Include every versioned field with its account. Remote validity and gateway compatibility need a separate approved live check. |
| Connectors, messaging, MCP and Vault | Credential files in `src/main/application-services.ts`; MCP OAuth/proxy, GitHub, messaging, Vault, 1Password, Bitwarden and voice stores | Version each adapter; include registrations, references and refresh metadata. Secret values never enter renderer payloads or reports. Imported connectors stay inactive until cutover. |
| Ingress and host secrets | `src/main/ingress-queue-key.ts`, team signing keys, remote desktop runtime secret | Preserve the exact keys when supported. Verify decryption and public/private relationships offline. Refuse regeneration as migration recovery. |
| File-based provider accounts | `src/backend/provider-drivers.ts`, `src/backend/process-confinement.ts`, `src/backend/agent/provider-account-store.ts` | Resolve configured homes and XDG paths, including OpenCode database/auth, Codex, Claude, Grok, Pi and Antigravity. A file can be readable yet contain an expired or device-bound token. Each provider needs a tested adapter. |
| macOS keychain accounts | Claude driver in `src/backend/provider-drivers.ts`; Cursor in `src/backend/agent/cursor-deep-login.ts` | Use supported per-account export only. Never copy the entire OS keychain. If export is unavailable or the credential is bound to a device, require sign-in on the destination while retaining identity/history. |
| Browser cookies and OS credentials | Browser profiles, OS keychain, external tools and hardware-backed keys | Inventory separately. Copyable profile bytes do not establish usable authentication. Device/hardware binding and OS policies can prevent transfer; show the exact reauthentication item. |
| Linux container keyring | `scripts/hosting/openbot-container`, `/data/.local/share/keyrings` and `/data/.config/openbot-container` | Keep the keyring and password in the same encrypted recovery unit. Same-container recovery is distinct from Mac-to-Linux re-encryption. Actual unlock remains a separate verification step. |

A portable bearer token still expires and can be revoked. A migration cannot override provider
validity rules. Unsupported export, unreadable ciphertext, unknown store versions, missing external
roots and unconfirmed account mappings block completion. Do not turn these failures into empty
credentials or silently overwrite them. Source revocation is not part of rehearsal or automatic
rollback: it can invalidate both copies and requires its own approved action.

## Stages and acceptance gates

1. **Inventory and compatibility.** Produce a redacted report from an explicit selected instance.
   List every root and category, count, destination mapping and unresolved item. Check exact fork
   build/schema compatibility, disk space, UID ownership, tool/runtime availability and target
   timezone. Stage 1 currently adds only `backup --keep-stopped` and its synthetic service test.
   No credential inventory command reads real stores in this PR.
2. **Consistent encrypted snapshot.** Before reading, obtain approval for the exact source and
   destination and the selected secret categories. Stop schedulers, queues, connectors, provider
   processes and other writers, including child servers that share a root. Confirm a clean stop.
   Capture all databases and dependent roots at one quiescent point, including WAL state where
   applicable. Keep a full source backup with a verified restore path. A normal live file copy or a
   DB-only backup cannot establish consistency across databases, files and secrets.
3. **Credential export and import adapters.** Source export and destination import need separate
   explicit approval for those exact actions. Use a reviewed, versioned authenticated encrypted
   envelope; do not implement ad hoc encryption. Include the private inventory, paths, identities,
   hashes, lengths, counts and source schema inside the envelope. Keep the public header minimal,
   with no account, path or identity details. Authenticate the envelope before extraction, reject
   unsafe paths/links and enforce resource limits. Plaintext secrets stay in the privileged
   process's memory, with no arguments, environment variables, logs, telemetry, renderer IPC,
   crash diagnostics or temporary plaintext files. Use a secure input channel for keys. Re-encrypt
   for the destination OS store. Cancellation must discard incomplete staging and keep the source
   recoverable. Wrong keys or tampered data must not modify the target.
4. **Offline restore rehearsal.** Import into an empty disposable destination with network egress,
   publishing, refresh, schedules, queues, messaging, approval automation and provider/tool startup
   disabled before any application service is constructed. No production profiles are mounted.
   First verify every file hash, schema, ID, count, attachment reference, shared owner and supported
   secret decryption. Then use synthetic providers to check session/path restoration and restart
   recovery. Preserve active intent as data, but run no task. Current backup `verify` is narrower
   than this gate. A future startup gate must enforce it; a UI checkbox alone cannot.
5. **One-writer cutover.** Show source/destination, exact build, snapshot digest, restore results,
   credential/reauthentication items, downtime and rollback reference for explicit approval.
   Fence source startup durably, including supervisors, update jobs and every identity copy.
   Recheck both states under the migration lock; `--keep-stopped` alone does not provide this.
   Only then enable destination publishing, provider reconnection, connectors and reviewed
   routines. Resolve missed schedules and pending ingress once, with no blind retries of uncertain
   actions. Confirm the new writer, then switch clients without resetting trust. Keep the source
   snapshot; do not delete it as part of cutover.
6. **Rollback.** Stop and fence the destination first. If it accepted new work, capture that work
   before reverting: the old snapshot cannot contain it, and there is no automatic merge today.
   Restore the complete source snapshot, including identity, secrets, both databases and files,
   with a compatible binary. Never start an older binary against an upgraded live database.
   Verify hashes/decryption and reconcile token rotations or delivery cursors before allowing the
   source to publish or run tasks. Keep the destination fenced. Test rollback after failed import,
   startup failure, cancelled cutover and a destination that already accepted synthetic work.

## Verification in this stage

Run `node --import tsx scripts/instance-backup-stop-e2e.ts`. Linux runs the real shell backup service
with injected host boundaries and real temporary files, tar/gzip and hashes. macOS runs the same
fixture in an unprivileged Debian container with no network, a read-only source mount and no Docker
socket. The first run can download its public base image. It does not run OpenBot or contact a
provider. The report is `.openbot-build/instance-backup-stop-e2e/report.json`.

The fixture checks normal restart, keep-stopped success with and without verification, argument
order, an already stopped source, copy failure cleanup, failed verification, unclean stop refusal,
preflight failure and unknown arguments. It checks archived synthetic workspace/keyring bytes and
hashes. Docker state, mount/UID boundaries and the verification callback are injected. This test
does not prove real Docker stop behavior, keyring unlock, SQLite verification or cross-OS migration.
The separate `scripts/instance-backup-e2e.ts` covers the full Linux backup/verify/restore path.

Unconfirmed after this code audit: actual credential portability and validity, browser-cookie
portability, provider session/path relocation, attachment reference completeness, a permanent
one-writer fence, safe full-app rehearsal startup and live Hermes/Grok gateway compatibility. No live
credential store, provider, gateway or production instance was opened. Hermes draft PRs #44 and #51
are separate authentication/setup work; they do not provide an OpenBot migration protocol.
