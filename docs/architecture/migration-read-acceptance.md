# Synthetic restore through the conversation read controller

This stage reads a generated restore with the actual
[ConversationQueries](../../src/backend/database/conversation-queries.ts) class. It does not start
OpenBot, admit offline application startup, export credentials or activate a destination. Local
hosting remains an option. No destination server or isolation boundary is selected by this test.

The fork's [startup interlock PR](https://github.com/jorge123255/openbotv/pull/59) remains deny-only.
This PR is independent of that entry change and of the earlier snapshot/path labs. It does not
replace their reduced fixture with a complete application profile.

## Dependency seam

[ReadDatabaseCore](../../src/backend/database/read-database-core.ts) exposes only a current
connection with prepared `get` and `all` operations. The controller still obtains `.connection`
at each use. It does not open a database, run migrations or own shutdown. The production facade
continues to supply its existing core; its public methods and released contracts stay the same.

The two search functions now live in
[search-sql-functions.ts](../../src/backend/database/search-sql-functions.ts). Their names and
callbacks are unchanged. Both normal database initialization and the acceptance reader register
them. The read controller no longer imports the writable core at runtime.

The type is a dependency seam, not SQL authorization. A prepared `all` call can still execute
mutating SQL. The acceptance process therefore uses SQLite `readOnly`, `query_only`, disabled
extension loading, and a read-only mount. It never constructs the application facade inside the
reader. Its fixed matching agent/thread IDs do not expose a new authorization API. Existing
whole-snapshot/page methods can read thread messages after an unsuccessful owner metadata lookup;
do not expose them directly to an untrusted caller as part of a future rehearsal service.

## Reproducible check

From the repository root, with frozen dependencies and Docker available:

```sh
node --import tsx scripts/migration-read-acceptance-e2e.ts
```

The command accepts no profile path. The fixture factory creates a private directory under
`.openbot-build/migration-read-acceptance/`, writes only synthetic data and closes its last SQLite
connection before it copies the tree. It uses real `OpenBotDatabase` and `AgentRoutineStore`
writes for a valid agent summary, four typed messages, message ordering, orchestration events and
receipts, an attached file, an inactive provider session and saved history cursor, and one active
and one paused routine. It creates no routine runs. This is a database fixture, not a complete
application profile, provider transcript or credential store.

The test builds only the reader and its allowed read dependencies. It refuses any other backend
source before loading it, including an injected import of the database facade. Contracts sources
and the installed `emoji-regex` package are allowed; Node builtins belong only to the fixed reader
entry. Output must be one chunk, with no recorded dynamic dependencies and only the six allowed
Node builtin imports. This checks the emitted graph; it is not a general JavaScript sandbox or
an exhaustive static proof against all computed code execution.

The generated tree and reader run in a pinned Node 24 image with no network, a read-only root and
mount, UID/GID 1000, dropped capabilities, no-new-privileges, and CPU/memory/PID limits. No host
home, secrets, SSH agent, devices or Docker socket is mounted. The host test uses Docker to create
the process; the reader has no Docker access. This container is not a VM or a per-agent executor.

The source remains in WAL mode. The reader refuses any WAL/SHM sidecar, then opens its closed,
read-only-mounted copy with `mode=ro&immutable=1`. SQLite documents immutable mode as one way to
read a WAL database without creating shared-memory files. It also requires the file to stay
unchanged; using it against a live database can return wrong results. See
[SQLite WAL read-only rules](https://www.sqlite.org/wal.html#read_only_databases) and
[URI parameters](https://www.sqlite.org/uri.html).
This test cannot establish consistency for a real running source. It does not change journal mode
or checkpoint a user's database.

Two separate reader starts check the following data and behavior:

- The actual controller reads all four saved message IDs, both history pages and a supported
  cursor; reads revision, runtime and turn projections; and finds selected/recovery messages.
- Multiword search finds a phrase split by a line break. File search uses Unicode lowercase.
- Native fixed inventory queries check roster identity, provider/session/history cursors, active
  and paused routine IDs, saved event/receipt presence and zero routine runs.
- The attached summary refers to the same fixture file and hash. Its source absolute path maps
  to the copy only for this fixed reader; no stored path is rewritten and no general relocation
  adapter or application attachment route is claimed.
- Database/filesystem writes fail, and the container exposes no external network interface.

Four separate damaged copies must exit 78 with only `SYNTHETIC_READ_ACCEPTANCE_REFUSED`: missing
database, a pending WAL marker, missing file, and a message rejected by the real page decoder.
No timeout, signal or Docker failure counts as a refusal. Each damaged copy remains unchanged
after the failed read. The source, original target and successful reader pack retain identical
file bytes, names and permission fingerprints across the process starts.

Every container has a generated owner name. Cleanup removes that exact container and checks its
absence, including after a Docker CLI timeout. A separate synthetic Node wait process prints a
ready marker, times out, and must leave no owned container. This process does not run the reader
or application. If Docker cannot confirm cleanup, the test fails and retains its generated mounts
and container names for diagnosis instead of deleting a potentially active mount.

The command removes its generated fixture directories. CI uploads only the fixed report:
`.openbot-build/migration-read-acceptance/report.json`. It records actual read-controller execution
but keeps `fullAppStartupTested`, `eventReplayTested`, `realCredentialsVerified`,
`duplicateExecutionProven` and `fullMigrationComplete` false. Persisted events are generated by
real writes; their replay is not tested here. Two reader starts do not prove production fencing.
`fullAppStartupAdmitted: false` describes this harness; it does not add an application launch mode.

## Startup effects excluded from the reader

This source review used fork main `161f0a673e202db626cb2104d15e01e87afc3dea`. `M` below means
[main index](../../src/main/index.ts), and `S` means
[application services](../../src/main/application-services.ts). Line numbers refer to that commit.
These paths must stay outside an admitted read graph. A routine timer hold cannot suppress them.

| Surface | Confirmed source effect | Required treatment |
| --- | --- | --- |
| Main imports/native/process | M:1–261 imports the service graph, configures TLS/environment/paths, acquires the instance lock, installs log/crash/watchdog and GPU marker paths. | Do not import main. The canonical interlock must decide before this graph. Native Electron bootstrap still precedes JavaScript. |
| OS/window/preferences | M:878–903 registers protocol/Linux desktop integration; M:1157 opens a window. S:1235 changes login items; S:1252–1267 can import approval settings. | Exclude presentation, preferences and normal IPC/renderer startup. |
| Logs/account | S:900–909 installs file sinks. S:971–974 forks account initialization; central-auth-manager:1348–1391 decrypts sessions and calls health/account endpoints, with clearing on 401. | Exclude account and normal logs, including token refresh and registration. |
| Writable storage/recovery | S:1020–1030 initializes AgentStore. database-core:64–105 opens WAL, migrates, chmods and can write a failure marker. agent-store:248–335 repairs/imports/reconciles files. | Use the separate read connection; do not initialize the facade/store or invoke replay/repair. |
| Skills/mailbox/identity | S:1056–1081 synchronizes skills and initializes mailbox/layout; S:2045 reconciles sidebar. TeamStore:235–315 can move logos, persist and prune records. | Exclude these owners; a method named load is not certified read-only. |
| Browser/native computer use | S:1117–1126 restores tabs; browser-host:434–483 wakes saved pages. S:1535–1687 wires runtimes/capture/input; S:2022 warms them. | No browser, native capture/input, overlays, permission UI or runtime processes. |
| Secrets/connectors | S:1327–1520,2880–2936 loads secret stores. MCP OAuth binds a listener at S:1421; GitHub load can bind proxy/write helpers/refresh tokens; 1Password load starts indexing. | No real stores or connectors. Unreadable bytes remain unavailable for later approved recovery. |
| Secret fallback/key files | ingress-queue-key:32–53 can replace unreadable keys. S:1674–1676 and1929 synchronize or remove Vault-derived key files. | Block before fallback, key creation and materialization. |
| Providers/AgentService | Runtime initialization at S:1318 removes staging/collects versions; S:2041,2069 installs/checks updates. AgentService construction at S:1688 wires a large runtime graph. | Exclude construction and initialization; the full transitive constructor graph is not certified inert. |
| Routines/workflows/ingress | S:1862–1971 wires runtime/feed/messaging. Messaging start is forked at S:859; feed starts at1965. AgentService:3483–3547 repairs turns, advances missed routines, starts providers, resumes pending runs and timers. S:3038–3042 runs workflow recovery. | No queue consumers, schedules, incoming listeners, replies, acknowledgments, subscriptions or recovery sweeps. |
| Host/remote/children | Host/account wiring at S:2366,2614–2621; remote sync at2825; local child startup at2800–2844; M:1316–1325,1428 starts remote connections. | No publishing, Team API, remote desktop, directory/presence/WebRTC, listeners or child supervisors. |
| Telemetry/voice/updates | S:2637–2734 constructs transports and flushes analytics/starts monitoring; S:2909 removes cache; S:2977 and M:1329 starts updater paths. S:3120–3224 can publish/retry/write status/stop. | Exclude sends, process sampling, cache cleanup, downloads, status writes and restart paths. |
| Shutdown | M:1612 flushes browser storage; M:1632 saves bounds. Teardown flushes files/traces. | Close only the owned read connection; do not reuse normal application teardown. |

This is a source inventory, not a complete certification of third-party import effects, native
Electron behavior or every preference-store fallback. Those remain unknown. No live stores were
read to make this inventory.

## Remaining admission work

The safe next stage is a separately reviewed read-only entry with a versioned input manifest,
complete supported schemas and explicit refusal for every unsupported data category. It must
retain the independent confinement and fixed reports before gaining any UI or broader query API.
Roster/provider-history/shared-data controllers require their own read/import review. The current
test does not grant an offline entry flag or accept user snapshots.

An actual full application restore still needs all excluded effects behind explicit capabilities,
approved encrypted credential adapters with reauthentication/unavailable results, full path and
attachment coverage, trust/executor eligibility, and a durable one-writer cutover with rollback.
No background execution may resume until the source is fenced and the destination is explicitly
activated. Copying a token cannot prove provider validity or reproduce an OS/hardware keychain.
No merge, deployment, real export/import, native app launch or production build is part of this stage.
