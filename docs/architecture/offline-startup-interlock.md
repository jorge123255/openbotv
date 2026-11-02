# Offline rehearsal startup interlock

Status: deny-only startup gate for this fork. It does not enable a full offline application mode,
read a profile, migrate data, verify credentials or fence another process. It is independent of
the synthetic snapshot, writer and path PRs. It must remain draft until its build/startup risks
are reviewed. Existing installed binaries and upstream images do not gain this gate from source.

## Entry before application imports

`src/main/startup-entry.ts` is the canonical main entry. It has no imports, logger, Electron,
provider, account, database or file API. It reads only argument strings and environment key names.
Any reserved rehearsal request prints `OPENBOT_OFFLINE_REHEARSAL_UNAVAILABLE` to stderr and exits
with status 78. No argument or environment value is printed, no profile is opened and no fallback
starts the application. There is no supported request that admits a full application rehearsal.

Without a reserved request, the entry awaits the original `src/main/index.ts`. That file is
unchanged. Existing server/child setup and application service ordering remain inside it.
The build emits it as `out/main/application.js`; the canonical entry stays `out/main/index.js`,
as package.json and development launchers expect. Shared main chunks also stay at the main root,
so existing preload, worker, renderer and resource paths based on `__dirname` retain their base.
Worker entry names and ASAR unpack rules are unchanged.

The installed electron-vite selects ESM for this package and Electron version. The normal import
is awaited at top level because Electron requires asynchronous setup needed before `ready` to be
awaited. See [Electron's ESM startup guidance](https://www.electronjs.org/docs/latest/tutorial/esm#you-must-use-await-generously-before-the-apps-ready-event).
This source/fixture check does not replace an actual packaged pre-ready timing test.

## Reserved lexical family

The canonical name is `openbot-offline-rehearsal`. For arguments and environment key names, the
interlock trims leading whitespace, folds case, changes underscores to hyphens, removes leading
ASCII hyphens and removes one optional `no-` prefix. Any normalized string that starts with the
canonical name is reserved, including unknown suffixes.

Examples include `--openbot-offline-rehearsal`, `--OPENBOT_OFFLINE_REHEARSAL`,
`--no-openbot-offline-rehearsal`, `OPENBOT_OFFLINE_REHEARSAL` and
`OPENBOT_OFFLINE_REHEARSAL_PROFILE`. Presence is decisive: empty, `0`, `false`, unknown values,
duplicates, conflicting values and requests after `--` all refuse. A false-looking value never
silently turns a requested rehearsal into a normal launch. Environment values are not examined.

This reserves a defined lexical family, not every possible typo, Unicode spelling or unrelated
offline option. It does not change the meaning of existing ordinary server/profile options.
Do not use a reserved request to test an older installed app: an old binary can ignore it and start
normally. Only the new canonical entry implements this refusal.

## Build output is checked

`scripts/offline-entry-integrity.ts` is a build-only plugin. It rejects output unless:

- The canonical entry and application are separate named ESM entries at the main root.
- The entry has zero static imports and contains only the bootstrap source module.
- There is one lazy application edge and exactly one import expression in the complete parsed AST.
- That expression is the awaited application import in a top-level `else`, with no `require`.

Counting AST expressions matters: bundle metadata can deduplicate two imports of the same target.
An eager import before the refusal must fail even if the lazy edge list still has one target.
Inlining, eager dependency hoisting, unsupported format or unexpected output layout fails the build.
No option such as unimplemented transitive-import hoisting is used as a safety guarantee.

The recursive visitor examines only the bundler's parsed ESTree objects. It treats heterogeneous
children as unknown until object/array/discriminant checks. It does not widen an application, IPC
or renderer boundary and uses no type assertion or suppression. The plugin is never imported by
the runtime entry or application graph.

## Synthetic verification

Run `node --import tsx scripts/offline-startup-entry-e2e.ts`. It uses the installed MainConfigFactory,
Vite and main configuration with the actual bootstrap. Every application and worker source is
replaced by a synthetic module; any other repository `src/` load is rejected. It builds no renderer,
preload, production application or installer and launches Node only. External/shared sentinels
record imports in a private generated fixture; they contain no real account/provider/network code.

Seven groups cover normal loading once, shared/application directory bases, 20 reserved request
forms, eager static and dynamic imports, an unawaited import, disabled splitting, and a missing
application file. Every refusal must finish with status 78, exact fixed stderr, empty stdout and
no sentinel execution. Missing normal application must finish with a numeric nonzero status, not a
timeout or spawn error; refusal still works without that file. Mutation builds must fail with the
expected guard or splitting diagnostic.

The report is `.openbot-build/offline-startup-entry-e2e/report.json`. Generated fixtures are removed;
CI uploads only the report. No real profile, credentials, provider, Electron application or network
probe is used, including the normal synthetic control.

## Scope and remaining gap

The proven boundary is refusal before the application JavaScript graph is imported through the
canonical emitted entry. It does not cover Electron's native bootstrap, which runs before this
JavaScript, or a caller that directly loads the internal application chunk. It is not a sandbox or
a production source/destination fence. No supported full application offline mode exists yet.

The actual full application bundle, packaged Electron/ASAR loading, platform argument delivery,
pre-ready timing and packaged worker/resource paths remain unverified here. macOS, Windows and
Linux package verification needs compatible built artifacts. No production build or package test
was run; those remain with George. Do not infer native profile/keychain/network safety from Node
sentinel fixtures.

A future admitted rehearsal must use complete compatible synthetic data and a reviewed startup
capability graph that excludes account health/session requests, writable database repair/migration,
browser restoration, credential refresh, provider/tool processes, queues, hosted-site recovery and
pending routines before any of them can start. Timer holds and routine catch-up files are not
sufficient. Real migration additionally needs encrypted approved credential adapters, verified
restore results and persistent one-writer cutover/rollback. This interlock grants none of those.

Executor placement also needs the [capability and eligibility report](migration-executor-eligibility.md).
Local hosting remains supported; Docker is not VM-per-agent isolation. A VM-per-agent provisioner
is separate security-sensitive work, with no management socket or privilege access granted here.
