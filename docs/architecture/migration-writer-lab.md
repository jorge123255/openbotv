# Synthetic one-writer and rollback lab

This development-only ledger models migration state. It cannot stop a source, start a destination,
fence an application or verify credentials. It imports no application, provider or network service.
Its API accepts no path. `SyntheticWriterGuard.create()` creates a new SQLite fixture under
`.openbot-build/instance-migration-writer-e2e/synthetic-ledger-*`. No live database is opened.

Run `node --import tsx scripts/instance-migration-writer-e2e.ts`. The entry point accepts no inputs.
It writes a fixed-code report to `.openbot-build/instance-migration-writer-e2e/report.json`.
CI uploads only the report. Synthetic ledgers remain as ignored development artifacts for inspection.
All connections are closed at the end of the fixture run.

## State and transition rules

Each mutation requires the exact expected epoch. One transaction reads the current state, checks
invariants, updates that epoch and appends the matching transition record. Stale or replayed
requests fail without a state change. Closing and reopening a connection preserves state and
fences. Reopening validates the current record against the latest journal entry and epoch count;
it does not reset an unreadable or missing ledger to a fresh migration.

| Operation | Required model state | Result |
| --- | --- | --- |
| Record rehearsal | Source active, destination inactive | Store self-reported synthetic evidence; incomplete evidence can be recorded but cannot allow cutover. |
| Fence source | Rehearsed, all evidence ready | Source fenced, destination offline. |
| Activate destination | Source fenced, all evidence ready | Destination active; source remains fenced. |
| Complete model | Destination active, all evidence ready | Mark the synthetic phase complete; this never means a real migration is complete. |
| Record destination work | Destination active | Increment work generation, including after model completion. |
| Fence destination | Source fenced, destination not yet fenced | Both sides fenced, including cancellation before destination activation. |
| Record rollback capture | Destination fenced | Record a verified capture only for the current work generation. No data is captured by this operation. |
| Resume source | Destination fenced, evidence ready, current work captured | Source active; destination remains fenced. |

Ready evidence requires complete inventory, verified snapshot/restore/backup, offline rehearsal
and synthetic verified-secret status. `reauth-required`, `unavailable`, missing evidence or a failed
check blocks activation and model completion. No state can contain two active writers. A destination
with new work cannot permit source resume until its exact current generation is marked captured.
Capturing an old generation, recording an unverified capture or resuming while the destination is
active is refused. A failed operation does not consume an epoch or silently retry.

## What the fixture proves

Six E2E groups drive the real SQLite-backed model: initial refusal, every evidence/credential blocker,
competing same-epoch requests, restart persistence, stale requests, source/destination ordering,
rollback after accepted synthetic work and cancellation before activation. Failures expose only a
tag and fixed code; raw SQLite messages, paths, evidence and causes are not reported.

The competing requests use two SQLite connections in one Node process. `DatabaseSync` serializes
their transactions. This checks a single winning transition for one expected epoch; it is not a
multiprocess lock-contention, crash-kill, network-partition or two-host coordination test. Reopen is
a connection-lifecycle test, not an application restart or host reboot test. The ledger is not a
cryptographically authenticated audit log.

All evidence is self-reported. The fixture's `verified` secret value contains no actual credential.
Capture generation is a model counter, not proof that destination files were saved or merged.
The report always sets `productionFencing`, `realSourceStopProven`, `realCredentialsVerified` and
`fullMigrationComplete` to false, even when the model phase reaches `complete`.

## Production gates still required

A real migration must bind evidence to exact identities, hosts, build/schema versions, snapshot
digests, credential results and approvals. It must enforce fences before application services can
start, and cover every supervisor, update job, child server and identity copy. An operator checkbox
or this self-reported ledger is insufficient. A verified offline restore must precede cutover; no
ledger operation grants permission to read real credentials or operate a server.

Rollback must first stop and durably fence the destination, save any new accepted work, reconcile
rotated tokens and delivery cursors, restore a complete compatible source snapshot, and verify it
before source activation. This model does none of those external actions and cannot prove they
occurred. Full credential export/import, path relocation and offline application startup remain
separate stages.

Fork [PR #55](https://github.com/jorge123255/openbotv/pull/55) separately checks synthetic snapshot
bytes and selected references. Fork PR #53 separately adds a Docker backup source-stop option.
This branch is independent of both and changes no Hermes or local-VM work.
