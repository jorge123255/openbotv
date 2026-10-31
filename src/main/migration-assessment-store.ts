// Owns immutable offline assessment records only. It never opens the application database.
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
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  decodeMigrationAssessmentReport,
  MIGRATION_ASSESSMENT_MAX_REVISION,
  type MigrationAssessmentReport,
} from "@openbot/contracts/ipc-migration-assessment";
import { Effect, Schema } from "effect";

const ROOT = "openbot-migration-assessments-v1";
const ANCHOR_PREFIX = ".record-";
const ANCHOR_FILE = "record.json";
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_DIRECTORY_ENTRIES = 160;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const Identifier = Schema.String.check(Schema.isMinLength(36), Schema.isMaxLength(36), Schema.isPattern(UUID));
const RecordEnvelope = Schema.Struct({
  format: Schema.Literal("openbot-migration-assessment"),
  version: Schema.Literal(1),
  anchorId: Identifier,
  planId: Identifier,
  revision: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(MIGRATION_ASSESSMENT_MAX_REVISION),
  ),
  reportJson: Schema.String,
  reportSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/), Schema.isMinLength(64), Schema.isMaxLength(64)),
});

export class MigrationAssessmentFailure extends Schema.TaggedError<MigrationAssessmentFailure>()(
  "MigrationAssessmentFailure",
  {
    code: Schema.Literals([
      "journal-unavailable",
      "journal-invalid",
      "revision-conflict",
      "assessment-limit",
      "preparation-unavailable",
      "preparation-changed",
      "inventory-unavailable",
      "source-unavailable",
      "unsupported-platform",
    ]),
  },
) {}

function invalid(): never {
  throw new MigrationAssessmentFailure({ code: "journal-invalid" });
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function failure(error: unknown): MigrationAssessmentFailure {
  return error instanceof MigrationAssessmentFailure
    ? error
    : new MigrationAssessmentFailure({ code: "journal-unavailable" });
}
function identifier(value: string): void {
  if (value.length !== 36 || !UUID.test(value)) invalid();
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function privateDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
      invalid();
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function ensureDirectory(path: string): void {
  if (privateDirectory(path)) return;
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  if (!privateDirectory(path)) invalid();
}
function syncDirectory(path: string): void {
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}
function readPrivateFile(path: string): { text: string; info: ReturnType<typeof fstatSync> } {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.nlink !== 2 ||
    before.size < 1 ||
    before.size > MAX_RECORD_BYTES ||
    (before.mode & 0o077) !== 0 ||
    (process.getuid && before.uid !== process.getuid())
  )
    invalid();
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(handle);
    if (
      !info.isFile() ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.nlink !== 2 ||
      info.size !== before.size
    )
      invalid();
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(handle, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length !== info.size || length > MAX_RECORD_BYTES) invalid();
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)), info };
  } finally {
    closeSync(handle);
  }
}

export interface StoredMigrationAssessment {
  revision: number;
  assessment: MigrationAssessmentReport | null;
}

/** Every committed revision retains one private anchor plus one exclusive final hard link.
 * No record is edited or deleted. This avoids an unlink recovery window and never replaces a winner.
 * It is local metadata persistence, not source authentication, a snapshot, or a distributed fence.
 */
export class MigrationAssessmentStore {
  readonly #userData: string;
  readonly #root: string;
  constructor(userDataPath: string) {
    this.#userData = userDataPath;
    this.#root = join(userDataPath, ROOT);
  }

  #requireSupported(): void {
    if (process.platform === "win32") throw new MigrationAssessmentFailure({ code: "unsupported-platform" });
  }

  readonly ensureSupported = Effect.fn("MigrationAssessmentStore.ensureSupported")(() =>
    Effect.try({ try: () => this.#requireSupported(), catch: failure }),
  );

  readonly read = Effect.fn("MigrationAssessmentStore.read")((planId: string) =>
    Effect.try({ try: () => this.#read(planId), catch: failure }),
  );
  readonly append = Effect.fn("MigrationAssessmentStore.append")(
    (expectedRevision: number, report: MigrationAssessmentReport) =>
      Effect.try({ try: () => this.#append(expectedRevision, report), catch: failure }),
  );

  #readRecord(directory: string, planId: string, revision: number): MigrationAssessmentReport {
    try {
      const final = readPrivateFile(join(directory, `${revision}.json`));
      const decoded = Schema.decodeUnknownSync(RecordEnvelope, { onExcessProperty: "error" })(JSON.parse(final.text));
      if (
        JSON.stringify(decoded) !== final.text ||
        decoded.planId !== planId ||
        decoded.revision !== revision ||
        hash(decoded.reportJson) !== decoded.reportSha256
      )
        invalid();
      const anchorDirectory = join(directory, `${ANCHOR_PREFIX}${decoded.anchorId}`);
      if (!privateDirectory(anchorDirectory)) invalid();
      const names = this.#names(anchorDirectory);
      if (names.length !== 1 || names[0] !== ANCHOR_FILE) invalid();
      const anchor = lstatSync(join(anchorDirectory, ANCHOR_FILE));
      if (!anchor.isFile() || anchor.nlink !== 2 || anchor.dev !== final.info.dev || anchor.ino !== final.info.ino)
        invalid();
      const report = decodeMigrationAssessmentReport(JSON.parse(decoded.reportJson));
      if (report.planId !== planId || report.revision !== revision || JSON.stringify(report) !== decoded.reportJson)
        invalid();
      return report;
    } catch {
      return invalid();
    }
  }

  #names(directory: string): string[] {
    const listing = opendirSync(directory);
    try {
      const names: string[] = [];
      for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
        if (names.length >= MAX_DIRECTORY_ENTRIES) invalid();
        names.push(entry.name);
      }
      return names;
    } finally {
      listing.closeSync();
    }
  }

  #read(planId: string): StoredMigrationAssessment {
    this.#requireSupported();
    identifier(planId);
    if (!privateDirectory(this.#root)) return { revision: 0, assessment: null };
    const directory = join(this.#root, planId);
    if (!privateDirectory(directory)) return { revision: 0, assessment: null };
    const revisions: number[] = [];
    for (const name of this.#names(directory)) {
      if (name.startsWith(ANCHOR_PREFIX)) {
        const anchorId = name.slice(ANCHOR_PREFIX.length);
        identifier(anchorId);
        if (!privateDirectory(join(directory, name))) invalid();
        // Unpublished candidates are ignored, never promoted or recursively removed.
        continue;
      }
      if (!/^(?:[1-9]|[12][0-9]|3[0-2])\.json$/.test(name)) invalid();
      revisions.push(Number(name.slice(0, -5)));
    }
    revisions.sort((a, b) => a - b);
    let assessment: MigrationAssessmentReport | null = null;
    for (const [index, revision] of revisions.entries()) {
      if (revision !== index + 1) invalid();
      assessment = this.#readRecord(directory, planId, revision);
    }
    return { revision: revisions.length, assessment };
  }

  #append(expectedRevision: number, report: MigrationAssessmentReport): StoredMigrationAssessment {
    this.#requireSupported();
    if (
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= MIGRATION_ASSESSMENT_MAX_REVISION
    )
      throw new MigrationAssessmentFailure({ code: "assessment-limit" });
    const validated = decodeMigrationAssessmentReport(report);
    identifier(validated.planId);
    if (validated.revision !== expectedRevision + 1)
      throw new MigrationAssessmentFailure({ code: "revision-conflict" });
    const current = this.#read(validated.planId);
    if (current.revision !== expectedRevision) throw new MigrationAssessmentFailure({ code: "revision-conflict" });
    const userData = lstatSync(this.#userData);
    if (!userData.isDirectory()) invalid();
    ensureDirectory(this.#root);
    const directory = join(this.#root, validated.planId);
    ensureDirectory(directory);
    if (this.#names(directory).length > MAX_DIRECTORY_ENTRIES - 2)
      throw new MigrationAssessmentFailure({ code: "assessment-limit" });
    const anchorId = randomUUID();
    const anchorDirectory = join(directory, `${ANCHOR_PREFIX}${anchorId}`);
    mkdirSync(anchorDirectory, { mode: 0o700 });
    const reportJson = JSON.stringify(validated);
    const envelope = {
      format: "openbot-migration-assessment",
      version: 1,
      anchorId,
      planId: validated.planId,
      revision: validated.revision,
      reportJson,
      reportSha256: hash(reportJson),
    };
    const bytes = JSON.stringify(envelope);
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) invalid();
    const anchorPath = join(anchorDirectory, ANCHOR_FILE);
    writeFileSync(anchorPath, bytes, { flag: "wx", mode: 0o600 });
    const handle = openSync(anchorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    syncDirectory(anchorDirectory);
    syncDirectory(directory);
    syncDirectory(this.#root);
    syncDirectory(this.#userData);
    try {
      linkSync(anchorPath, join(directory, `${validated.revision}.json`));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new MigrationAssessmentFailure({ code: "revision-conflict" });
      throw error;
    }
    // Failure here is an uncertain completed append. Retain both links and recover by reading state.
    syncDirectory(directory);
    return this.#read(validated.planId);
  }
}
