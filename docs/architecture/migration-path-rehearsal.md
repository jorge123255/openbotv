# Synthetic path relocation and restricted projection rehearsal

This stage is stacked on the synthetic snapshot lab in fork PR #55. Main is still `161f0a67`.
It accepts no real source, target or credentials. The lab generates all data under its private
build-output directory. Operational paths are private; the exposed inspection view is frozen.

## Supported transformation

Only the new staged destination main database is changed, in one transaction. The source and
original snapshot stay unchanged. There are exactly three supported scalar changes in the dataset:

| Field | Change | Data retained |
| --- | --- | --- |
| Agent JSON `workspacePath` | Declared `/synthetic-source/workspace/...` to final generated target root | All other JSON keys, IDs and provider-account association |
| Generated attachment `path` column | Declared Shared/Transfers path to final target | ID, hash, length and owner references |
| Same attachment JSON `path` | Same target as the path column | All other metadata |

The adapter uses `json_set`, not a reconstructed partial JSON object. It does not replace strings
globally. Conversation summaries keep their empty index path. Quoted message/file paths, provider
histories, cursors, shared data and placeholder event/receipt bytes remain unchanged.

Stored paths name the final target, never the temporary staging directory. Validation maps those
final paths into staging before publication, then validates actual target paths after the rename.
Root lookalikes, traversal, wrong root categories, missing/wrong-type files and unsupported path
categories are refused. Populated deletion-outbox or MCP configuration tables, non-placeholder
events and any change from the pristine generated child database block relocation. This does not
implement child-server, MCP, deletion-outbox, provider-history or event-replay path migration.

## Preservation proof

The original manifest and byte inventory are checked before copying. After the three scalar
changes, only those same fields are normalized back to their original virtual paths for proof.
Every table row/count/digest is then compared, including internal tables such as `sqlite_sequence`.
Schema objects have a separate digest, so a new index, trigger or view cannot pass as an allowed
path change. The two other database files and all non-main-database bytes/modes must match.
The main database mode is checked separately; its physical bytes can change during the transaction.

Source and snapshot fingerprints, including the original manifest, are checked after success and
failure. Incomplete staging is removed. An existing target is refused. Injected failure during the
transaction, after transformation, or after an unexpected row/schema/sequence edit must not publish
a target. Retrying starts from the retained original snapshot. These are controlled-fixture checks,
not a guarantee against hostile filesystem races or other applications writing concurrently.

Run `node --import tsx scripts/instance-migration-path-e2e.ts`. The report is
`.openbot-build/instance-migration-path-e2e/report.json`. Thirteen groups cover transformation,
unknown-field retention, final-path resolution, transaction/failure cleanup, schema/sequence proof,
unsupported state and frozen inspection paths. This stage does not establish real portability.

## Restricted projection reader

Run `node --import tsx scripts/instance-migration-projection-e2e.ts`. This requires Docker and can
download the pinned public Node 24 image on first use. It starts a fixed reader twice, sequentially,
with these boundaries:

- Unprivileged UID/GID 1000, all capabilities dropped, no-new-privileges, and bounded CPU/memory/PIDs.
- Read-only container root; only a generated readable copy and one fixed reader script are mounted.
- `--network=none`; the reader checks that it has no external interface. No outbound probe is sent.
- No host home, keyring, credential store, SSH agent, devices or Docker socket is mounted.
- SQLite opens with `readOnly: true`, `allowExtension: false`, `query_only=ON` and `trusted_schema=OFF`.

The fixed SQL reader checks roster/history IDs, mapped files, attachment hashes, shared ownership,
routine intent and zero routine-run rows. It verifies database and fixture write attempts fail.
Source, snapshot and restored target hashes must remain unchanged after both starts. CI uploads
only `.openbot-build/instance-migration-projection-e2e/report.json`.

This is a restricted synthetic projection process, not OpenBot startup or a test of its actual
query controllers. It imports no application graph, database facade, agent store, provider,
connector, scheduler or secret store. Active/paused routine intent is preserved as data; execution
is absent because those services are never constructed. Zero routine runs in this reader does not
prove that a full application or another host cannot execute the same work.

## Full application startup is blocked

The exact pending action is an Electron/OpenBot launch against the relocated profile. It was not
attempted. There is no gate that suppresses all startup effects before they occur:

- `src/main/index.ts:249–259` starts logging, crash reporting and the exit watchdog at module scope.
- `src/main/application-services.ts:971–974` starts account initialization, which can request the
  account service (`src/main/central-auth-manager.ts:1348–1391`).
- `src/backend/database/database-core.ts:64–105` opens writable SQLite, selects WAL, migrates and
  changes permissions; its options have no read-only mode.
- `src/main/application-services.ts:1116–1131` restores browser tabs. Connector and runtime setup
  can bind listeners, refresh tokens and start local child servers.
- `src/backend/agent-service.ts:3483–3547` reconciles provider files, recovers turns, starts providers,
  resumes pending routine runs and arms timers. A routine timer hold does not stop these paths.

Therefore no claim of full offline startup, duplicate-execution safety, credential portability or
production fencing is made. Reports keep `fullAppStartupTested`, `duplicateExecutionProven`,
`realCredentialsVerified` and `fullMigrationComplete` false. Full startup remains blocked until a
reviewed gate exists before these effects, plus real persistent source/destination fencing and a
compatible, complete fixture. The current reduced JSON/placeholder events are storage fixtures,
not application-load or event-replay fixtures.
