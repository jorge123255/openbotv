# Local migration preparation

Server settings → **Migration preparation** saves a local preparation plan. Choose Local desktop,
Docker host, or Other server, then select **Save preparation plan**. The choice records an intent;
it does not connect to or configure a destination. A saved plan can be reloaded, cancelled, and
replaced after cancellation. It survives a normal service restart.

Export, restore, and activation are disabled. Saving a plan does not stop agents or schedules, copy
data or credentials, create a snapshot, or establish a single writer. Continue to use existing
hosting options independently. A Docker host choice does not provision a container or a VM.

## Production path

`WorkspaceOverlays` supplies the local desktop bridge to the real `ServerSettingsModal` and
`ServerMigrationPreparationPanel`. The renderer store serializes requests. It reads state after an
uncertain mutation result and never replays that mutation. If recovery fails, mutations remain
disabled until an explicit reload succeeds. Disposal discards late replies.

The new local-only `migrationPreparation` IPC group has three methods: `getState`, `prepare`, and
`cancel`. Existing trusted-sender checks run before strict payload decoders. There is no remote
Team API capability or change to `instance-transfer-v1`. Input has only a destination kind and
expected revision, plus a plan ID for cancellation. Main returns fixed localized errors. Preload
independently validates the complete response, including all disabled operations and blockers.

`MigrationPreparationService` observes five integer counts in one SELECT on the initialized
application database: agent records, conversation threads, message records, canonical attachment
records, and agent routine definitions. Channel routines and channel messages are not counted.
Message attachment indices are excluded to avoid counting the same attachment twice. No names,
messages, paths, account metadata, credential stores, file content,
provider APIs, or directories are inventoried. These are provisional database counts. They are
neither a verified file inventory nor a consistent database/filesystem snapshot and can become stale.

The service owns `openbot-migration-preparation-v1.db` under Electron userData. Its constructor does
no IO. Reading a missing journal with no sidecars returns an empty state without creating a file. A prepare/cancel
uses a short SQLite transaction with a revision check and synchronous FULL. A prepared plan cannot
be overwritten; cancel must name its matching ID and revision first. Each call closes its handle.
This journal adds no application database migration.

Only count metadata, a random plan ID, timestamps, destination kind, revision, status, six fixed
blockers, and disabled operations are saved. New journals are mode 0600. Strict version/schema,
application ID, canonical payload, integrity and size checks refuse invalid or unknown journals.
Symlinks, hardlinks, WAL files and unexpected sidecars refuse. A failed/partial journal is retained
for diagnosis and is never silently reset or repaired. The local file checks are defensive checks
within the existing userData trust boundary, not protection from a hostile same-user process that
can race filesystem changes. The SQLite journal is not a distributed lease or a cutover fence.

First save prepares a complete, validated SQLite candidate in a private staging directory before
publishing the final journal. Exclusive hard-link publication cannot replace an existing journal.
An interrupted publication can leave two names for the same complete file. Recovery must verify
the bounded private publication marker, file identity, hash and journal format before it detaches
the known staging link. Unrecognized links and files remain refused and unchanged. An interrupted
candidate that was never published does not become an empty final journal and does not block a new
first-save attempt.

Final-journal sidecars are checked even when the main journal is absent. An orphan `-journal`,
`-wal` or `-shm` file or symlink refuses before SQLite can open or create the final journal. No
unknown sidecar is deleted or replayed. Existing-plan transactions that leave a hot rollback
journal after interruption therefore require diagnosis; this is not a general SQLite crash-repair
feature. Tests of selected process-interruption windows do not establish power-loss durability or
support on an untested operating system. Required filesystem sync failures refuse or leave an
uncertain completed publication for a later state read; they never authorize deleting a valid plan.
First-save publication currently refuses on Windows because this implementation has no verified
Windows directory-sync adapter. The destination selector does not establish Windows host support.

## Verification and limits

Run these narrow checks with Node and existing dependencies:

```sh
node --import tsx scripts/migration-preparation-e2e.ts
bun run test:desktop -- src/main/ipc/migration-preparation-handlers.test.ts
bun run storybook --no-open --quiet
# In another terminal, use the loopback URL printed by the registered Storybook wrapper:
node --import tsx scripts/migration-preparation-ui-e2e.ts --url=http://localhost:6006
```

Reports and UI screenshots are under `.openbot-build/migration-preparation{,-ui}-e2e/`. All profiles,
credentials canaries and source records are generated in isolated fixture directories. The browser
test uses the real settings container/store, production coordinator, production inventory adapter,
real OpenBotDatabase and preload decoder. Its story-only binding injects the coordinator; actual IPC
sender/payload/error behavior is tested separately with the real registered handlers. Browser
restart checks construct a new coordinator against the same journal. The service acceptance also
kills real writer child processes before publication, after the final link and after the candidate
link is removed, then checks the saved bytes and recovery behavior. It tests a competing writer and
injected SQLite/sync failures. None of these checks restarts a packaged Electron app. No real
provider, account, browser profile, credential store or live application is opened.

Native Electron startup/packaging and the full application graph have not been exercised by this
slice. The tests do not certify cross-platform data portability, full restore or production fencing.
SQLite SHM reader bookkeeping can change during count reads; source preservation checks cover
durable database/WAL content and saved routine intent.

## Gates before a real move

All six blockers remain unresolved on every saved plan:

1. Configure and authenticate a chosen destination and verify executor capabilities. Keep local
   hosting available; process, container and VM isolation must be reported accurately.
2. Quiesce all writers and verify a consistent snapshot, full inventory, hashes, attachment/shared
   references, IDs, history and explicit path mappings.
3. Implement approved encrypted credential adapters, protected key delivery and destination rewrap.
   OS/device/provider-bound credentials can require sign-in; hardware credentials may be unavailable.
4. Establish a durable single-writer handoff, including source restart refusal and crash recovery.
5. Restore into an isolated destination and verify complete synthetic application behavior with
   provider, connector, account, browser and routine effects denied before admission.
6. Implement deliberate activation, backup retention and verified rollback. Token rotation or
   external side effects can make a byte-for-byte rollback insufficient.

The earlier snapshot/path/read/credential labs are evidence for selected mechanisms, not production
adapters. Their success cannot clear any of these blockers. Real export, destination writes,
credential use and activation need separately reviewable implementations and explicit authorization.
