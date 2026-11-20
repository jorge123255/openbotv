# Offline destination assessment

The proposed next stage is [authenticated destination verification](migration-destination-verification.md).
It requires pairing and build-policy decisions; no destination connection is available yet.

This stage extends [migration preparation](migration-preparation.md). In the local Server settings,
save a preparation plan, then use **Offline destination assessment**. Declare a target platform,
architecture, OpenBot version, schema version, executor boundary, data ownership and persistence.
Version fields can remain empty when unknown. No URL, path, command, socket or credential is accepted.

The app compares these declarations with local metadata and saves an assessment. The possible
results are **No known mismatch**, **Mismatch**, and **Insufficient information**. These describe
the observed metadata and declarations. They never certify a destination. Every report keeps
`destinationVerified:false`, `inventoryComplete:false`, all six preparation blockers and disabled
export, restore and activation. This stage does not configure a host or move data.

## What is observed

The fixed category register covers 29 categories. Eighteen SQL groups partition all 76 tables of
the current schema, version 47: schema metadata, search index, agents, conversations, memories,
mailbox/queues, attachments/deletion intents, channels, direct chat, routines, webhooks, messaging,
provider sessions/history, usage, MCP configuration, browser identities, workflows and events/receipts.
The other eleven categories are explicitly uninspected: workspace files, shared files, attachment
files/drafts, the separate shared database, browser partitions, provider homes/runtimes, configuration
files, trust, credentials, child instances and unclassified files such as recovery/import/cache data.

This is complete **category coverage**, not a complete inventory of belongings. A count is a SQLite
row count, not a count of distinct messages, identities or files. Projections, summaries and FTS
tables can repeat logical data. Each table's observation stops at 10,001 rows; a clipped category is
reported as a lower bound. Paths stop at 4,096 references. Unrecognized or missing tables/version
produce unknown coverage instead of dynamic queries against unknown tables. `unmappedTables` is a
bounded observed count, not a guaranteed total of unknown tables.

Source schema recognition checks the bounded table-name register and observed maximum migration
version. It does not validate full DDL, constraints, triggers, foreign keys, replay consistency or
every migration marker. These checks do not run schema repair or migrations. Counts/path/access
metadata use one SQL statement after the schema precheck and recheck names/version in that statement.
The source remains live; this is not a consistent database/filesystem snapshot.

The reader extracts only selected path scalars from agent workspace/additional/excluded folders,
attachment references, deletion intents and MCP working directories. It classifies references as
managed, userData, external, relative, URI, invalid, default or summary. Paths stay private in main;
the renderer receives counts only. Classification is lexical. Files are never opened or traversed,
and symlinks, mounts, existence, readability, hashes and real containment remain uninspected.
Additional path-bearing data in commands, environment, URLs, pending/backup runtime settings and
opaque event/history/workflow/configuration values remains unknown.

Stored intent counts cover provider sessions, deliveries, active routines, workflows/steps, pending
result delivery, waits and agents that require confined-process workspace enforcement. Unknown
provider metadata produces unknown counts. A lower bound of zero does not prove absence. No count
proves that writers stopped. Row/result limits do not provide a hard execution-time bound or make
synchronous SQLite work interruptible.

## Compatibility and credentials

Source platform, architecture and version come from the running host, not the renderer's fallback.
A noncanonical source version is unknown. Matching version strings do not establish identical build
identity. The declared schema must match the observed source version for this stage's comparison.
No conversion or downgrade is attempted. Unknown facts stay unknown.

The current runtime matrix has macOS/Linux x64 and arm64, and Windows x64. This is not proof that
every provider works on those targets. Docker declarations require Linux and a container boundary.
An executor declaration is never evidence of actual isolation; no VM, per-agent VM or privileged
socket is provisioned. Local desktop hosting remains a choice.

Workspace-only agents whose provider uses confined-process enforcement currently require macOS.
A declared Linux/Windows target is flagged when such stored agents are observed. The assessment
never changes access to make a target appear compatible. External roots need explicit mapping;
unconfigured, unknown or ephemeral storage remains a finding. Declared persistent storage is still
unverified.

Credential stores, browser sessions, CLI homes and OS stores are not read. Presence, validity,
portability and device binding remain unknown. A real move needs approved unwrap/rewrap adapters or
sign-in. OS-, provider-, device- and hardware-bound credentials can require reauthentication or be
unavailable; a copied encrypted file does not prove destination usability. No agents, account IDs,
histories, grants or sessions are recreated here, and no restored approval or queued work is enabled.

## Production ownership and persistence

The real preparation panel embeds the assessment controller. A separate local `migrationAssessment`
IPC group has `getState` and `assess`, with strict sender/input validation and an independent preload
response decoder. No released Team API or `instance-transfer-v1` protocol changes. There is no remote
connection, destination probe, credential accessor, provider call or routine start in this service.
All service constructors perform no IO. A state read does not run the inventory.

Assessment input names the saved preparation UUID/revision and expected assessment revision. The
service checks the plan, reads source metadata/inventory, checks the plan again and appends the
report. It reads preparation again before responding. The two journals are not one transaction:
another window can cancel/change a plan around publication. Such a report is retained and returned
as stale, never used for activation. `current` means only that the report matches the preparation
binding at the last read; it does not establish current source contents or quiescence.

Preparation's version-1 journal and format stay unchanged. Assessments use a separate private
`openbot-migration-assessments-v1/<plan-uuid>/` directory, with up to 32 immutable revisions. Each
record is completed and synced in a private UUID directory, then exclusively hard-linked to its
numbered final name. The anchor remains permanently: exactly two names must reference the same
inode. There is no anchor-unlink crash window and no overwrite fallback. A strict bounded canonical
envelope pins plan/revision, report JSON and its hash. Reads validate the complete report and anchor.
The hash detects corruption; it is not authentication against the same user.
A copy that breaks the hard-link relationship is not an admitted restore. A future transfer adapter
must preserve or verify/reconstruct that relationship; this stage has no import or repair path.

Directories use mode 0700 and files 0600. Only contiguous bounded revisions are accepted. Unknown
entries/formats, BOMs, malformed data, unsafe links or altered anchors refuse without repair or
cleanup. Unpublished private anchors are ignored and retained. Too many entries require diagnosis;
the service does not recursively delete anything. Old reports remain when a plan is cancelled or
replaced. Failed post-link sync can mean publication completed; the renderer reloads state and never
replays an uncertain assessment. All Windows assessment operations refuse before reading preparation
or assessment storage. No verified native permissions and directory-sync adapter exists. The UI
explains this, blocks automatic reads, and disables saving and reloading. POSIX ownership, permission,
and file-identity checks remain unchanged.

These checks assume the existing userData trust boundary. They do not defend against a hostile
same-user filesystem racer, prove power-loss durability, authenticate a destination, fence another
host or replace backups. Source database/WAL, credentials and preparation records are not modified
by inventory/assessment; SQLite SHM reader bookkeeping can change.

## Narrow verification

```sh
node --import tsx scripts/migration-assessment-inventory-e2e.ts
node --import tsx scripts/migration-assessment-e2e.ts
node --import tsx scripts/migration-assessment-publication-e2e.ts
bun run test:desktop -- src/main/ipc/migration-assessment-handlers.test.ts --maxWorkers=1
bun run storybook --no-open --quiet
# Use the loopback URL printed by the registered Storybook wrapper:
node --import tsx scripts/migration-assessment-ui-e2e.ts --url=http://localhost:6006
```

All profiles, source records and credential canaries are generated. Tests use actual database
facade writes, preparation/assessment services, inventory policy, durable store, decoders and
settings components. The browser uses story-only injected calls; actual IPC trust behavior is tested
separately. Publication tests kill owned writer child processes before/after the final link, race a
publisher and inject sync failures. An isolated simulated-Windows process verifies rejection before
filesystem, preparation, source or inventory access. Browser cases verify zero assessment calls for
empty and existing report histories on a simulated Windows source. These do not prove native Windows
storage support. Native/full Electron startup, packaged builds, Windows storage,
live providers, real credentials, a remote target and a full restored application are not tested.
The browser check asserts no immutable-store update diagnostics. Select popups still emit the pinned
Kobalte dismissable-layer effect-callback read diagnostic in development; a one-select fixture
reproduces the dependency location. These diagnostics are recorded, not suppressed, and no dependency
patch or version change is included.

Reports and screenshots are under `.openbot-build/migration-assessment*-e2e/`. CI runs the narrow
scripts after the branch targets a configured CI base. The normal CI workflow selects only PRs to
main, so a draft stacked on the preparation feature branch does not automatically run that workflow.
Do not dispatch the broad workflow or infer green CI from local reports.

Actual full-house migration still needs authenticated destination capability/root checks, complete
consistent snapshot/file/reference verification, approved encrypted credentials and sign-ins,
durable one-writer cutover, isolated full-app restore admission, deliberate activation and verified
rollback. No successful offline assessment clears those gates.
