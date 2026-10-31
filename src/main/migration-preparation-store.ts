// Owns only the count-only migration preparation journal, never the application database.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
const CANDIDATE_PREFIX = ".openbot-migration-preparation-publish-";
const CANDIDATE_DATABASE = "journal.db";
const PUBLICATION_MARKER = "publication.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const Marker = Schema.Struct({
  format: Schema.Literal("openbot-migration-preparation-publication"),
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isPattern(UUID), Schema.isMinLength(36), Schema.isMaxLength(36)),
  target: Schema.Literal(MIGRATION_PREPARATION_JOURNAL),
  candidate: Schema.Literal(CANDIDATE_DATABASE),
  dev: Schema.Number,
  ino: Schema.Number,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
type PublicationMarker = typeof Marker.Type;
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

function fileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syncDirectory(path: string): void {
  // There is no portable Windows directory-fsync contract in this implementation. Refuse before
  // publication there; do not substitute an overwrite-prone rename or claim power-loss durability.
  if (process.platform === "win32") throw new MigrationPreparationFailure({ code: "journal-unavailable" });
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function syncFile(path: string): void {
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function boundedFile(path: string, maximum: number, identity?: FileIdentity): Buffer {
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(handle);
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > maximum ||
      (identity && (info.dev !== identity.dev || info.ino !== identity.ino))
    )
      invalid();
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (read === 0) invalid();
      offset += read;
    }
    if (fstatSync(handle).size !== info.size) invalid();
    return bytes;
  } finally {
    closeSync(handle);
  }
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
    this.#requireNoSidecars(this.#path);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(this.#path);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (!info.isFile() || (info.nlink !== 1 && info.nlink !== 2) || info.size < 100 || info.size > MAX_JOURNAL_BYTES)
      invalid();
    this.#header(this.#path);
    if (info.nlink === 2) {
      this.#recoverPublication(info);
      info = lstatSync(this.#path);
      if (!info.isFile() || info.nlink !== 1) invalid();
    }
    return { dev: info.dev, ino: info.ino };
  }

  #requireNoSidecars(path: string): void {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        lstatSync(`${path}${suffix}`);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      invalid();
    }
  }

  #header(path: string): void {
    // Refuse WAL-format files before opening SQLite: even a read-only WAL open can create sidecars.
    const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
  }

  #sameFile(identity: FileIdentity): void {
    const current = lstatSync(this.#path);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino)
      invalid();
  }

  #marker(directory: string, id: string): PublicationMarker {
    const path = join(directory, PUBLICATION_MARKER);
    let handle: number | undefined;
    try {
      handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(handle);
      if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 1024 || (info.mode & 0o077) !== 0)
        invalid();
      if (process.getuid && info.uid !== process.getuid()) invalid();
      const text = boundedFile(path, 1024, info).toString("utf8");
      const value = JSON.parse(text);
      const marker = Schema.decodeUnknownSync(Marker, { onExcessProperty: "error" })(value);
      if (marker.id !== id || JSON.stringify(marker) !== text) invalid();
      return marker;
    } catch {
      return invalid();
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }

  #recoverPublication(identity: FileIdentity): void {
    const candidates: Array<{ directory: string; marker: PublicationMarker }> = [];
    const listing = opendirSync(this.#directory);
    try {
      let entries = 0;
      let candidateCount = 0;
      for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
        if (++entries > 4096) invalid();
        if (!entry.name.startsWith(CANDIDATE_PREFIX)) continue;
        const id = entry.name.slice(CANDIDATE_PREFIX.length);
        if (id.length !== 36 || !UUID.test(id)) continue;
        if (++candidateCount > 64) invalid();
        const directory = join(this.#directory, entry.name);
        const folder = lstatSync(directory);
        if (!folder.isDirectory() || (folder.mode & 0o077) !== 0 || (process.getuid && folder.uid !== process.getuid()))
          continue;
        let info: ReturnType<typeof lstatSync>;
        try {
          info = lstatSync(join(directory, CANDIDATE_DATABASE));
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        if (!info.isFile() || info.dev !== identity.dev || info.ino !== identity.ino) continue;
        if (
          info.nlink !== 2 ||
          JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([CANDIDATE_DATABASE, PUBLICATION_MARKER])
        )
          invalid();
        this.#requireNoSidecars(join(directory, CANDIDATE_DATABASE));
        const marker = this.#marker(directory, id);
        if (marker.dev !== identity.dev || marker.ino !== identity.ino) invalid();
        candidates.push({ directory, marker });
      }
    } finally {
      listing.closeSync();
    }
    if (candidates.length !== 1) invalid();
    const candidate = candidates[0];
    if (!candidate || fileHash(boundedFile(this.#path, MAX_JOURNAL_BYTES, identity)) !== candidate.marker.sha256)
      invalid();
    const db = new DatabaseSync(this.#path, { readOnly: true, allowExtension: false });
    try {
      db.exec("PRAGMA trusted_schema = OFF");
      const state = this.#readConnection(db);
      if (state.revision !== 1 || state.plan?.status !== "prepared") invalid();
    } finally {
      db.close();
    }
    // Recognition proves only this private userData publication layout, not an external sender.
    syncDirectory(this.#directory);
    this.#finishPublication(candidate.directory, candidate.marker);
  }

  #finishPublication(directory: string, marker: PublicationMarker): void {
    const candidate = join(directory, CANDIDATE_DATABASE);
    try {
      const names = readdirSync(directory).sort();
      if (
        JSON.stringify(names) !== JSON.stringify([CANDIDATE_DATABASE, PUBLICATION_MARKER]) &&
        JSON.stringify(names) !== JSON.stringify([PUBLICATION_MARKER])
      )
        invalid();
    } catch (error) {
      if (!missing(error)) throw error;
      this.#sameFile(marker);
      syncDirectory(this.#directory);
      return;
    }
    try {
      const current = lstatSync(candidate);
      if (!current.isFile() || current.dev !== marker.dev || current.ino !== marker.ino || current.nlink !== 2)
        invalid();
      unlinkSync(candidate);
      syncDirectory(directory);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    this.#sameFile(marker);
    try {
      // A peer may already have completed the verified cleanup; an unknown remaining entry is
      // never removed and must not cause us to remove its publication marker.
      if (JSON.stringify(readdirSync(directory)) !== JSON.stringify([PUBLICATION_MARKER])) invalid();
      if (JSON.stringify(this.#marker(directory, marker.id)) !== JSON.stringify(marker)) invalid();
      unlinkSync(join(directory, PUBLICATION_MARKER));
      // Never recurse through a candidate directory or delete an unexpected entry.
      rmdirSync(directory);
    } catch (error) {
      if (!missing(error) && !(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error;
    }
    syncDirectory(this.#directory);
  }

  #firstSave(next: MigrationPreparationState): MigrationPreparationState {
    if (process.platform === "win32") throw new MigrationPreparationFailure({ code: "journal-unavailable" });
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const directory = join(this.#directory, `${CANDIDATE_PREFIX}${id}`);
    mkdirSync(directory, { mode: 0o700 });
    const candidate = join(directory, CANDIDATE_DATABASE);
    const handle = openSync(
      candidate,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(handle);
    const db = new DatabaseSync(candidate, { allowExtension: false, timeout: 0 });
    try {
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
      try {
        db.exec(`${TABLE}; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`);
        db.prepare("INSERT INTO migration_preparation_state(singleton,format_version,state_json) VALUES (1,1,?)").run(
          JSON.stringify(next),
        );
        this.#readConnection(db);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
    this.#requireNoSidecars(candidate);
    this.#header(candidate);
    syncFile(candidate);
    const info = lstatSync(candidate);
    if (!info.isFile() || info.nlink !== 1) invalid();
    const marker: PublicationMarker = {
      format: "openbot-migration-preparation-publication",
      version: 1,
      id,
      target: MIGRATION_PREPARATION_JOURNAL,
      candidate: CANDIDATE_DATABASE,
      dev: info.dev,
      ino: info.ino,
      sha256: fileHash(boundedFile(candidate, MAX_JOURNAL_BYTES, info)),
    };
    writeFileSync(join(directory, PUBLICATION_MARKER), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
    syncFile(join(directory, PUBLICATION_MARKER));
    syncDirectory(directory);
    syncDirectory(this.#directory);
    this.#requireNoSidecars(this.#path);
    try {
      linkSync(candidate, this.#path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new MigrationPreparationFailure({ code: "revision-conflict" });
      throw error;
    }
    // A failure from here is an uncertain completed publication. Never remove/reset the final file.
    syncDirectory(this.#directory);
    this.#finishPublication(directory, marker);
    return next;
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
    const proposed = decodePreparationJournalState(JSON.stringify(change(observed)));
    if (proposed.revision !== observed.revision + 1) invalid();
    const identity = this.#identity();
    if (!identity) return this.#firstSave(proposed);
    const db = new DatabaseSync(this.#path, { allowExtension: false, timeout: 0 });
    try {
      this.#sameFile(identity);
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
      try {
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
