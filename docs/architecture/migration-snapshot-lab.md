# Synthetic snapshot and offline restore lab

This is a development-only storage/reference rehearsal for the full-house migration request.
It is not a migration command or an application restore engine. No caller can select a source,
target or credential path. The entry point accepts no arguments and creates its own synthetic
data under `.openbot-build/instance-migration-rehearsal/fixture-*`.

Operational paths are private and frozen. The public `paths` getter exposes a `Readonly` inspection
view; capture, restore and recursive disposal use only private roots. The regression check attempts
harmless mutations only after confirming the view is frozen. If run against mutable code, any
successful assignment is restored before an assertion or cleanup. It never calls disposal with
an altered path, and it confirms normal disposal removes only the original generated root.

Run `node --import tsx scripts/instance-migration-rehearsal-e2e.ts`. The fixed-code report is
`.openbot-build/instance-migration-rehearsal/report.json`. The fixture directories are removed
after each run. CI uploads the report, not the fixture databases or files.

## What is checked

The lab creates the current real OpenBot schema through `migrateOpenBotDatabase`, without starting
an application or provider. Data roots cover synthetic userData, workspace, Shared, provider history,
a separate child database, browser-profile marker, downloads and skills. Every declared root,
regular file, directory and empty directory is inventoried. Files have byte lengths, SHA-256 hashes
and modes. Every non-internal table in each of the three databases has a row count and logical
digest. The schema version is recorded where a migrations table exists.

The main database has fixed agent, thread, message, memory, provider session/cursor, routine, trigger,
attachment and event/receipt records. Shared tables retain their agent ownership. A canonical
generated attachment has stored path/hash metadata; the conversation has only its summary and an
index row with an empty path, as in the application. The verifier resolves that summary to the
stored bytes and checks ownership. It checks primary-thread ownership, not only ID existence.

The lab requires its synthetic writer state to be stopped before capture. It inventories before
and after copying and rejects a mismatch. This state is a model flag; no real process is stopped.
The snapshot manifest digest is retained by the same lab object. A changed manifest, an extra or
missing file, corrupt bytes, invalid SQLite references or unsafe paths refuse restoration.
This in-memory digest is not an encrypted or signed portable export format.

Restore first verifies the snapshot, then copies into a new staging directory. It verifies the
copy before publishing the disposable target. It refuses an existing target, preserves source
and target bytes on refusal, cleans incomplete staging and supports retry after an injected copy
failure. Symlinks, hardlinks, other file types, undeclared roots, case/normalization collisions and
Windows-reserved path components are unsupported. Size/count limits refuse the snapshot; they
do not silently omit data. This is a controlled fixture lab, not an adversarial concurrent-filesystem
exporter with directory-handle protections.

## Paths, credentials and execution

Stored paths use the declared virtual prefix `/synthetic-source`. The verifier checks each supported
path stays in a declared root and resolves its suffix in the restored tree. It does not rewrite
the database, provider history or quoted path text. `pathStatus` is `mapping-only-no-rewrite`.
No application should start against this restored tree.

Credential categories are explicit, with `reauthentication-required` or `unavailable`. There are no
real keys, tokens, cookies, secret exports or OS credential-store reads. The host marker contains a
synthetic ID and unavailable-key status; it does not prove signing-key or host-session recovery.
The child database is a separate empty current-schema database; it is not a running child server.

Routines retain active/paused intent, including an overdue trigger. The scheduler, messaging,
approvals, provider processes and application startup graph are never constructed, so no task runs.
The report always sets `fullMigrationComplete: false` and `productionStartupPermitted: false`.
Offline verification does not authorize a source/destination cutover.

## Scope and next gates

The fixture uses reduced synthetic agent/message JSON and a placeholder event in the real schema.
It proves storage and selected reference preservation for this generated dataset. It does not prove
application loading, event replay, provider-session usability, application restart recovery, support
for every historical schema, all attachment kinds or actual Mac-to-Linux migration.
File metadata coverage is limited to POSIX mode bits. Ownership, ACLs, extended attributes, sparse
layout, hardware/OS credentials and running sessions are not restored or verified by this lab.

Production adapters still need explicit inventory of all external roots, consistent real writer
quiescence, authenticated encrypted export, approved credential adapters, OS re-encryption,
schema-specific path relocation, a startup gate before secret fallback writes, an offline full-app
rehearsal and a durable fence for all supervisors before one-writer cutover. Rollback must first fence
the destination and preserve work accepted after the snapshot. This lab supplies no such controls.

Fork PR #53 separately adds the Docker backup source-stop option and the broader migration design.
The local-VM design and Hermes gateway setup are separate work; this lab changes neither.

The next [path and projection stage](migration-path-rehearsal.md) adds a separate synthetic-only
relocation method. The original mapping-only restore remains available. Inventory proof now also
includes schema objects and internal SQLite table rows, including sequence state.
