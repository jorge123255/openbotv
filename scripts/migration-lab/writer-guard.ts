// Synthetic migration model only. This ledger cannot fence a real host, prove that a source is
// stopped, verify a backup, move data, or start an application. All evidence is self-reported.

import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";

const Counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Epoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Evidence = Schema.Struct({
  syntheticOnly: Schema.Literal(true),
  inventoryComplete: Schema.Boolean,
  snapshotVerified: Schema.Boolean,
  restoreVerified: Schema.Boolean,
  rehearsalOffline: Schema.Boolean,
  backupVerified: Schema.Boolean,
  secrets: Schema.Literals(["verified", "reauth-required", "unavailable"]),
});
export type SyntheticWriterEvidence = typeof Evidence.Type;

const Snapshot = Schema.Struct({
  scope: Schema.Literal("synthetic-self-reported"),
  epoch: Epoch,
  source: Schema.Literals(["active", "fenced"]),
  destination: Schema.Literals(["offline", "active", "fenced"]),
  phase: Schema.Literals([
    "source-active",
    "rehearsed",
    "source-fenced",
    "destination-active",
    "destination-fenced",
    "source-resumed",
    "complete",
  ]),
  evidence: Schema.NullOr(Evidence),
  destinationWorkGeneration: Counter,
  capturedWorkGeneration: Counter,
});
export type SyntheticWriterSnapshot = typeof Snapshot.Type;

const FailureCode = Schema.Literals([
  "ledger-io",
  "ledger-invalid",
  "ledger-closed",
  "stale-epoch",
  "invalid-transition",
  "inventory-incomplete",
  "snapshot-unverified",
  "restore-unverified",
  "offline-rehearsal-required",
  "backup-unverified",
  "secrets-reauth-required",
  "secrets-unavailable",
  "rollback-capture-required",
  "rollback-capture-unverified",
  "counter-exhausted",
]);

/** Fixed codes only. SQLite messages, paths, data and causes must not enter a report. */
export class SyntheticWriterFailure extends Schema.TaggedError<SyntheticWriterFailure>()("SyntheticWriterFailure", {
  code: FailureCode,
}) {}

type FailureCode = typeof FailureCode.Type;
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);
const decodeEpoch = Schema.decodeUnknownSync(Epoch);
const decodeEvidence = Schema.decodeUnknownSync(Evidence);

function failure(code: FailureCode): SyntheticWriterFailure {
  return new SyntheticWriterFailure({ code });
}

function safeFailure(cause: unknown): SyntheticWriterFailure {
  return cause instanceof SyntheticWriterFailure ? cause : failure("ledger-io");
}

function requireReady(evidence: SyntheticWriterEvidence | null): void {
  if (!evidence?.inventoryComplete) throw failure("inventory-incomplete");
  if (!evidence.snapshotVerified) throw failure("snapshot-unverified");
  if (!evidence.restoreVerified) throw failure("restore-unverified");
  if (!evidence.rehearsalOffline) throw failure("offline-rehearsal-required");
  if (!evidence.backupVerified) throw failure("backup-unverified");
  if (evidence.secrets === "reauth-required") throw failure("secrets-reauth-required");
  if (evidence.secrets === "unavailable") throw failure("secrets-unavailable");
}

function requireInvariant(snapshot: SyntheticWriterSnapshot): void {
  if (snapshot.source === "active" && snapshot.destination === "active") throw failure("ledger-invalid");
  if (snapshot.capturedWorkGeneration > snapshot.destinationWorkGeneration) throw failure("ledger-invalid");
  switch (snapshot.phase) {
    case "source-active":
    case "rehearsed":
      if (snapshot.source !== "active" || snapshot.destination !== "offline") throw failure("ledger-invalid");
      break;
    case "source-fenced":
      if (snapshot.source !== "fenced" || snapshot.destination !== "offline") throw failure("ledger-invalid");
      requireReady(snapshot.evidence);
      break;
    case "destination-active":
    case "complete":
      if (snapshot.source !== "fenced" || snapshot.destination !== "active") throw failure("ledger-invalid");
      requireReady(snapshot.evidence);
      break;
    case "destination-fenced":
      if (snapshot.source !== "fenced" || snapshot.destination !== "fenced") throw failure("ledger-invalid");
      break;
    case "source-resumed":
      if (snapshot.source !== "active" || snapshot.destination !== "fenced") throw failure("ledger-invalid");
      if (snapshot.destinationWorkGeneration !== snapshot.capturedWorkGeneration) throw failure("ledger-invalid");
      break;
  }
}

/**
 * Owns one connection to a disposable SQLite ledger under a fixed build-output directory. No
 * caller can select a database path. A peer shares only this synthetic fixture. Closing or
 * reopening a handle does not change the saved epoch or state. No app service is imported.
 */
export class SyntheticWriterGuard {
  readonly #path: string;
  #database: DatabaseSync | null;

  private constructor(path: string, create = false) {
    this.#path = path;
    this.#database = this.#connect(create);
  }

  static readonly create = Effect.fn("SyntheticWriterGuard.create")(function* () {
    return yield* Effect.try({
      try: () => {
        const root = resolve(".openbot-build/instance-migration-writer-e2e");
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const directory = mkdtempSync(join(root, "synthetic-ledger-"));
        return new SyntheticWriterGuard(join(directory, "synthetic-writer.db"), true);
      },
      catch: safeFailure,
    });
  });

  readonly snapshot = Effect.fn("SyntheticWriterGuard.snapshot")(function* (this: SyntheticWriterGuard) {
    return yield* Effect.try({ try: () => this.#read(this.#requireDatabase()), catch: safeFailure });
  }).bind(this);

  readonly openPeer = Effect.fn("SyntheticWriterGuard.openPeer")(function* (this: SyntheticWriterGuard) {
    return yield* Effect.try({
      try: () => {
        this.#requireDatabase();
        return new SyntheticWriterGuard(this.#path);
      },
      catch: safeFailure,
    });
  }).bind(this);

  readonly close = Effect.fn("SyntheticWriterGuard.close")(function* (this: SyntheticWriterGuard) {
    yield* Effect.try({
      try: () => {
        this.#database?.close();
        this.#database = null;
      },
      catch: safeFailure,
    });
  }).bind(this);

  readonly reopen = Effect.fn("SyntheticWriterGuard.reopen")(function* (this: SyntheticWriterGuard) {
    yield* Effect.try({
      try: () => {
        if (this.#database !== null) throw failure("invalid-transition");
        this.#database = this.#connect();
      },
      catch: safeFailure,
    });
  }).bind(this);

  readonly recordRehearsal = Effect.fn("SyntheticWriterGuard.recordRehearsal")(function* (
    this: SyntheticWriterGuard,
    expectedEpoch: number,
    evidence: SyntheticWriterEvidence,
  ) {
    return yield* this.#transition(expectedEpoch, "record-rehearsal", (current) => {
      if (current.source !== "active" || current.destination === "active") throw failure("invalid-transition");
      let decoded: SyntheticWriterEvidence;
      try {
        decoded = decodeEvidence(evidence);
      } catch {
        throw failure("ledger-invalid");
      }
      return { ...current, phase: "rehearsed", destination: "offline", evidence: decoded };
    });
  }).bind(this);

  readonly fenceSource = Effect.fn("SyntheticWriterGuard.fenceSource")(function* (
    this: SyntheticWriterGuard,
    expectedEpoch: number,
  ) {
    return yield* this.#transition(expectedEpoch, "fence-source", (current) => {
      if (current.phase !== "rehearsed") throw failure("invalid-transition");
      requireReady(current.evidence);
      return { ...current, source: "fenced", phase: "source-fenced" };
    });
  }).bind(this);

  readonly activateDestination = Effect.fn("SyntheticWriterGuard.activateDestination")(function* (
    this: SyntheticWriterGuard,
    expectedEpoch: number,
  ) {
    return yield* this.#transition(expectedEpoch, "activate-destination", (current) => {
      requireReady(current.evidence);
      if (current.phase !== "source-fenced") throw failure("invalid-transition");
      return { ...current, destination: "active", phase: "destination-active" };
    });
  }).bind(this);

  readonly recordDestinationWork = Effect.fn("SyntheticWriterGuard.recordDestinationWork")(function* (
    this: SyntheticWriterGuard,
    expectedEpoch: number,
  ) {
    return yield* this.#transition(expectedEpoch, "record-destination-work", (current) => {
      if (current.destination !== "active") throw failure("invalid-transition");
      if (current.destinationWorkGeneration === Number.MAX_SAFE_INTEGER) throw failure("counter-exhausted");
      return { ...current, destinationWorkGeneration: current.destinationWorkGeneration + 1 };
    });
  }).bind(this);

  readonly fenceDestination = Effect.fn("SyntheticWriterGuard.fenceDestination")(function* (
    this: SyntheticWriterGuard,
    expectedEpoch: number,
  ) {
    return yield* this.#transition(expectedEpoch, "fence-destination", (current) => {
      if (current.source !== "fenced" || current.destination === "fenced") throw failure("invalid-transition");
      return { ...current, destination: "fenced", phase: "destination-fenced" };
    });
  }).bind(this);

  readonly recordRollbackCapture = Effect.fn("SyntheticWriterGuard.recordRollbackCapture")(function* (
    this: SyntheticWriterGuard,
    expectedEpoch: number,
    capturedGeneration: number,
    verified: boolean,
  ) {
    return yield* this.#transition(expectedEpoch, "record-rollback-capture", (current) => {
      if (current.phase !== "destination-fenced") throw failure("invalid-transition");
      if (!verified || capturedGeneration !== current.destinationWorkGeneration)
        throw failure("rollback-capture-unverified");
      return { ...current, capturedWorkGeneration: capturedGeneration };
    });
  }).bind(this);

  readonly resumeSource = Effect.fn("SyntheticWriterGuard.resumeSource")(function* (
    this: SyntheticWriterGuard,
    expectedEpoch: number,
  ) {
    return yield* this.#transition(expectedEpoch, "resume-source", (current) => {
      if (current.phase !== "destination-fenced") throw failure("invalid-transition");
      requireReady(current.evidence);
      if (current.destinationWorkGeneration !== current.capturedWorkGeneration)
        throw failure("rollback-capture-required");
      return { ...current, source: "active", phase: "source-resumed" };
    });
  }).bind(this);

  readonly complete = Effect.fn("SyntheticWriterGuard.complete")(function* (
    this: SyntheticWriterGuard,
    expectedEpoch: number,
  ) {
    return yield* this.#transition(expectedEpoch, "complete", (current) => {
      requireReady(current.evidence);
      if (current.phase !== "destination-active") throw failure("invalid-transition");
      return { ...current, phase: "complete" };
    });
  }).bind(this);

  #requireDatabase(): DatabaseSync {
    if (this.#database === null) throw failure("ledger-closed");
    return this.#database;
  }

  #connect(create = false): DatabaseSync {
    const database = new DatabaseSync(this.#path);
    try {
      database.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (create)
        database.exec(`
        CREATE TABLE IF NOT EXISTS synthetic_writer (
          singleton INTEGER PRIMARY KEY CHECK (singleton=1), epoch INTEGER NOT NULL, snapshot_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS synthetic_transitions (
          epoch INTEGER PRIMARY KEY, action TEXT NOT NULL, snapshot_json TEXT NOT NULL
        );
      `);
      database.exec("BEGIN IMMEDIATE");
      if (create && !database.prepare("SELECT epoch FROM synthetic_writer WHERE singleton=1").get()) {
        const initial: SyntheticWriterSnapshot = {
          scope: "synthetic-self-reported",
          epoch: 1,
          source: "active",
          destination: "offline",
          phase: "source-active",
          evidence: null,
          destinationWorkGeneration: 0,
          capturedWorkGeneration: 0,
        };
        const json = JSON.stringify(initial);
        database.prepare("INSERT INTO synthetic_writer VALUES (1, 1, ?)").run(json);
        database.prepare("INSERT INTO synthetic_transitions VALUES (1, 'create', ?)").run(json);
      }
      this.#read(database);
      database.exec("COMMIT");
      return database;
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  #read(database: DatabaseSync): SyntheticWriterSnapshot {
    const row = database.prepare("SELECT epoch, snapshot_json FROM synthetic_writer WHERE singleton=1").get();
    if (!row || typeof row.snapshot_json !== "string") throw failure("ledger-invalid");
    const latest = database
      .prepare("SELECT epoch, snapshot_json FROM synthetic_transitions ORDER BY epoch DESC LIMIT 1")
      .get();
    const history = database.prepare("SELECT count(*) AS entries FROM synthetic_transitions").get();
    if (latest?.epoch !== row.epoch || latest?.snapshot_json !== row.snapshot_json || history?.entries !== row.epoch)
      throw failure("ledger-invalid");
    let decoded: SyntheticWriterSnapshot;
    try {
      decoded = decodeSnapshot(JSON.parse(row.snapshot_json));
    } catch {
      throw failure("ledger-invalid");
    }
    if (row.epoch !== decoded.epoch) throw failure("ledger-invalid");
    requireInvariant(decoded);
    return decoded;
  }

  #transition(
    expectedEpoch: number,
    action: string,
    change: (current: SyntheticWriterSnapshot) => SyntheticWriterSnapshot,
  ): Effect.Effect<SyntheticWriterSnapshot, SyntheticWriterFailure> {
    return Effect.try({
      try: () => {
        try {
          decodeEpoch(expectedEpoch);
        } catch {
          throw failure("stale-epoch");
        }
        const database = this.#requireDatabase();
        database.exec("BEGIN IMMEDIATE");
        try {
          const current = this.#read(database);
          if (expectedEpoch !== current.epoch) throw failure("stale-epoch");
          if (current.epoch === Number.MAX_SAFE_INTEGER) throw failure("counter-exhausted");
          const next = { ...change(current), epoch: current.epoch + 1 };
          requireInvariant(next);
          const json = JSON.stringify(next);
          const written = database
            .prepare("UPDATE synthetic_writer SET epoch=?, snapshot_json=? WHERE singleton=1 AND epoch=?")
            .run(next.epoch, json, current.epoch);
          if (written.changes !== 1) throw failure("stale-epoch");
          database.prepare("INSERT INTO synthetic_transitions VALUES (?, ?, ?)").run(next.epoch, action, json);
          database.exec("COMMIT");
          return next;
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      },
      catch: safeFailure,
    });
  }
}
