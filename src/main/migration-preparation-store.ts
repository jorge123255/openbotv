// Owns only the count-only migration preparation journal, never the application database.
import { closeSync, constants, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeMigrationPreparationState,
  type MigrationPreparationState,
} from "@openbot/contracts/ipc-migration-preparation";
import { Effect, Schema } from "effect";

export const MIGRATION_PREPARATION_JOURNAL = "openbot-migration-preparation-v1.db";
const MAX_REVISION = 2_147_483_647;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 8 * 1024;
const APPLICATION_ID = 0x4f424d50;
const TABLE = `CREATE TABLE migration_preparation_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  format_version INTEGER NOT NULL CHECK(format_version = 1),
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
) STRICT`;
const normalizeSql = (value: string) => value.replace(/\s+/g, " ").trim();

export class MigrationPreparationFailure extends Schema.TaggedError<MigrationPreparationFailure>()(
  "MigrationPreparationFailure",
  {
    code: Schema.Literals([
      "journal-unavailable",
      "journal-invalid",
      "inventory-unavailable",
      "revision-conflict",
      "plan-mismatch",
      "plan-already-prepared",
      "invalid-input",
    ]),
  },
) {}

function unavailable(error: unknown): MigrationPreparationFailure {
  return error instanceof MigrationPreparationFailure
    ? error
    : new MigrationPreparationFailure({ code: "journal-unavailable" });
}

function invalid(): never {
  throw new MigrationPreparationFailure({ code: "journal-invalid" });
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** The private stored format rejects extra fields, duplicate keys and noncanonical JSON. */
function decodePreparationJournalState(text: string): MigrationPreparationState {
  try {
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) invalid();
    const value = JSON.parse(text);
    if (JSON.stringify(value) !== text) invalid();
    const decoded = decodeMigrationPreparationState(value);
    if (JSON.stringify(decoded) !== text) invalid();
    if (
      (decoded.plan === null && decoded.revision !== 0) ||
      (decoded.plan?.status === "prepared" && decoded.revision < 1) ||
      (decoded.plan?.status === "cancelled" && decoded.revision < 2)
    )
      invalid();
    return decoded;
  } catch {
    return invalid();
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

/** One short-lived handle per operation; a corrupt/unknown journal is never repaired or reset. */
export class MigrationPreparationStore {
  readonly #directory: string;
  readonly #path: string;

  constructor(userDataPath: string) {
    this.#directory = userDataPath;
    this.#path = join(userDataPath, MIGRATION_PREPARATION_JOURNAL);
  }

  readonly read = Effect.fn("MigrationPreparationStore.read")(() =>
    Effect.try({ try: () => this.#read(), catch: unavailable }),
  );

  readonly update = Effect.fn("MigrationPreparationStore.update")(
    (expectedRevision: number, change: (state: MigrationPreparationState) => MigrationPreparationState) =>
      Effect.try({ try: () => this.#update(expectedRevision, change), catch: unavailable }),
  );

  #identity(): FileIdentity | null {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(this.#path);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (!info.isFile() || info.nlink !== 1 || info.size < 100 || info.size > MAX_JOURNAL_BYTES) invalid();
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        lstatSync(`${this.#path}${suffix}`);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      invalid();
    }
    // Refuse WAL-format files before opening SQLite: even a read-only WAL open can create sidecars.
    const handle = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(100);
      if (
        readSync(handle, header, 0, header.length, 0) !== 100 ||
        header.subarray(0, 16).toString("ascii") !== "SQLite format 3\u0000" ||
        header[18] !== 1 ||
        header[19] !== 1
      )
        invalid();
    } finally {
      closeSync(handle);
    }
    return { dev: info.dev, ino: info.ino };
  }

  #sameFile(identity: FileIdentity): void {
    const current = lstatSync(this.#path);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino)
      invalid();
  }

  #readConnection(db: DatabaseSync): MigrationPreparationState {
    try {
      const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
      if (
        schema.length !== 1 ||
        schema[0]?.type !== "table" ||
        schema[0].name !== "migration_preparation_state" ||
        typeof schema[0].sql !== "string" ||
        normalizeSql(schema[0].sql) !== normalizeSql(TABLE) ||
        db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID ||
        db.prepare("PRAGMA user_version").get()?.user_version !== 1
      )
        invalid();
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") invalid();
      const rows = db
        .prepare("SELECT singleton,format_version,state_json FROM migration_preparation_state LIMIT 2")
        .all();
      if (
        rows.length !== 1 ||
        rows[0]?.singleton !== 1 ||
        rows[0].format_version !== 1 ||
        typeof rows[0].state_json !== "string"
      )
        invalid();
      return decodePreparationJournalState(rows[0].state_json);
    } catch {
      return invalid();
    }
  }

  #read(): MigrationPreparationState {
    const identity = this.#identity();
    if (!identity) return { revision: 0, plan: null };
    const db = new DatabaseSync(this.#path, { readOnly: true, allowExtension: false });
    try {
      this.#sameFile(identity);
      db.exec("PRAGMA trusted_schema = OFF");
      return this.#readConnection(db);
    } finally {
      db.close();
    }
  }

  #update(
    expectedRevision: number,
    change: (state: MigrationPreparationState) => MigrationPreparationState,
  ): MigrationPreparationState {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= MAX_REVISION)
      throw new MigrationPreparationFailure({ code: "revision-conflict" });
    const observed = this.#read();
    if (observed.revision !== expectedRevision) throw new MigrationPreparationFailure({ code: "revision-conflict" });
    // Validate the domain transition before creating a new journal.
    decodePreparationJournalState(JSON.stringify(change(observed)));
    let created = false;
    if (!this.#identity()) {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      try {
        const handle = openSync(
          this.#path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        closeSync(handle);
        created = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    const identity = created ? lstatSync(this.#path) : this.#identity();
    if (!identity) invalid();
    const db = new DatabaseSync(this.#path, { allowExtension: false, timeout: 0 });
    try {
      this.#sameFile(identity);
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
      try {
        if (created) {
          db.exec(`${TABLE}; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`);
          db.prepare("INSERT INTO migration_preparation_state(singleton,format_version,state_json) VALUES (1,1,?)").run(
            JSON.stringify({ revision: 0, plan: null }),
          );
        }
        const current = this.#readConnection(db);
        if (current.revision !== expectedRevision) throw new MigrationPreparationFailure({ code: "revision-conflict" });
        const next = decodePreparationJournalState(JSON.stringify(change(current)));
        if (next.revision !== current.revision + 1) invalid();
        db.prepare("UPDATE migration_preparation_state SET state_json = ? WHERE singleton = 1").run(
          JSON.stringify(next),
        );
        db.exec("COMMIT");
        return next;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }
}
