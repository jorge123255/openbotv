// Synthetic-only service. Its constructor is private; create() generates the only readable source.
// There is no path input, CLI export command, provider, secret-store or application startup here.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { normalizedRow, relativeStoredPath, relocateSyntheticDatabase } from "./path-relocation";
import {
  CREDENTIALS,
  type InventoryEntry,
  LabFailure,
  Manifest,
  ROOTS,
  relativePath,
  type SnapshotManifest,
  sha256,
} from "./snapshot-model";
import { writeSyntheticHouse } from "./synthetic-house";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const JsonAgent = Schema.Struct({ id: Schema.String, threadId: Schema.String, workspacePath: Schema.String });
const Summary = Schema.Struct({ id: Schema.String, name: Schema.String, size: Schema.Number });
const StoredAttachment = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
  ownerAgentId: Schema.String,
  ownerThreadId: Schema.String,
});
const Message = Schema.Struct({ id: Schema.String, attachments: Schema.Array(Summary) });
const AgentRow = Schema.Struct({ agent_id: Schema.String, thread_id: Schema.String, agent_json: Schema.String });
const ThreadRow = Schema.Struct({ thread_id: Schema.String, agent_id: Schema.String });
const AttachmentRow = Schema.Struct({
  attachment_id: Schema.String,
  owner_kind: Schema.String,
  owner_id: Schema.String,
  path: Schema.String,
  metadata_json: Schema.String,
});
const MessageRow = Schema.Struct({ thread_id: Schema.String, message_id: Schema.String, message_json: Schema.String });
const OwnerRow = Schema.Struct({ table_name: Schema.String, owner_agent_id: Schema.String });

function failure(error: unknown): LabFailure {
  return error instanceof LabFailure ? error : new LabFailure({ code: "FIXTURE_IO" });
}

async function fileBytes(root: string, path: string): Promise<Buffer> {
  relativePath(path);
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new LabFailure({ code: "UNSUPPORTED_ENTRY" });
    if (stat.size > MAX_FILE_BYTES) throw new LabFailure({ code: "INVENTORY_LIMIT" });
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new LabFailure({ code: "SOURCE_CHANGED" });
    return bytes;
  } finally {
    await handle.close();
  }
}

async function inventory(root: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [];
  const portable = new Set<string>();
  let totalBytes = 0;
  async function visit(path: string): Promise<void> {
    relativePath(path);
    const collisionKey = path.normalize("NFC").toLowerCase();
    if (portable.has(collisionKey)) throw new LabFailure({ code: "PORTABLE_PATH_COLLISION" });
    portable.add(collisionKey);
    const stat = await lstat(join(root, path));
    if (!stat.isDirectory() && !stat.isFile()) throw new LabFailure({ code: "UNSUPPORTED_ENTRY" });
    const bytes = stat.isFile() ? await fileBytes(root, path) : Buffer.alloc(0);
    totalBytes += bytes.length;
    if (entries.length >= 512 || totalBytes > MAX_TOTAL_BYTES) throw new LabFailure({ code: "INVENTORY_LIMIT" });
    entries.push({
      path,
      kind: stat.isDirectory() ? "directory" : "file",
      bytes: bytes.length,
      mode: stat.mode & 0o777,
      sha256: sha256(bytes),
    });
    if (stat.isDirectory())
      for (const child of (await readdir(join(root, path))).sort()) await visit(`${path}/${child}`);
  }
  const roots = (await readdir(root)).sort();
  if (JSON.stringify(roots) !== JSON.stringify([...ROOTS].sort())) throw new LabFailure({ code: "UNDECLARED_ROOT" });
  for (const path of roots) await visit(path);
  return entries;
}

function databaseInventory(root: string, path: string, storedRoot?: string) {
  const db = new DatabaseSync(join(root, path), { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (
      JSON.stringify(integrity.map((row) => row.integrity_check)) !== '["ok"]' ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new LabFailure({ code: "DATABASE_INVALID" });
    const names = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    );
    const tables = names.map(({ name }) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new LabFailure({ code: "DATABASE_INVALID" });
      const rows = db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => (storedRoot && path === "userdata/openbot.db" ? normalizedRow(db, name, row, storedRoot) : row))
        .map((row) => JSON.stringify(row))
        .sort();
      return { name, rows: rows.length, sha256: sha256(JSON.stringify(rows)) };
    });
    const version = names.some((item) => item.name === "schema_migrations")
      ? Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Number }))(
          db.prepare("SELECT max(version) AS version FROM schema_migrations").get(),
        ).version
      : null;
    const schemaSha256 = sha256(
      JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name").all()),
    );
    return { path, schemaVersion: version, schemaSha256, tables };
  } finally {
    db.close();
  }
}

async function checkRelationships(root: string, storedRoot = "/synthetic-source"): Promise<number> {
  const db = new DatabaseSync(join(root, "userdata/openbot.db"), { readOnly: true });
  let shared: DatabaseSync | null = null;
  let mapped = 0;
  try {
    shared = new DatabaseSync(join(root, "shared/Data/agent-data.db"), { readOnly: true });
    db.exec("PRAGMA trusted_schema=OFF");
    shared.exec("PRAGMA trusted_schema=OFF");
    const agents = Schema.decodeUnknownSync(Schema.Array(AgentRow))(
      db.prepare("SELECT agent_id,thread_id,agent_json FROM projection_agents").all(),
    );
    const threads = Schema.decodeUnknownSync(Schema.Array(ThreadRow))(
      db.prepare("SELECT thread_id,agent_id FROM projection_threads").all(),
    );
    const agentIds = new Set(agents.map((row) => row.agent_id));
    const threadIds = new Set(threads.map((row) => row.thread_id));
    const threadOwners = new Map(threads.map((row) => [row.thread_id, row.agent_id]));
    for (const row of agents) {
      const agent = Schema.decodeUnknownSync(JsonAgent)(JSON.parse(row.agent_json));
      if (
        agent.id !== row.agent_id ||
        agent.threadId !== row.thread_id ||
        threadOwners.get(row.thread_id) !== row.agent_id
      )
        throw new LabFailure({ code: "RELATIONSHIP_INVALID" });
      const stat = await lstat(join(root, relativeStoredPath(agent.workspacePath, storedRoot)));
      if (!stat.isDirectory()) throw new LabFailure({ code: "RELATIONSHIP_INVALID" });
      mapped++;
    }
    if (threads.some((row) => !agentIds.has(row.agent_id))) throw new LabFailure({ code: "RELATIONSHIP_INVALID" });
    const attachments = Schema.decodeUnknownSync(Schema.Array(AttachmentRow))(
      db.prepare("SELECT attachment_id,owner_kind,owner_id,path,metadata_json FROM projection_attachments").all(),
    );
    const canonical = new Map<string, typeof StoredAttachment.Type>();
    for (const row of attachments.filter((row) => row.owner_kind === "generated")) {
      const stored = Schema.decodeUnknownSync(StoredAttachment)(JSON.parse(row.metadata_json));
      if (
        stored.id !== row.attachment_id ||
        stored.id !== row.owner_id ||
        stored.path !== row.path ||
        !agentIds.has(stored.ownerAgentId) ||
        !threadIds.has(stored.ownerThreadId) ||
        threadOwners.get(stored.ownerThreadId) !== stored.ownerAgentId
      )
        throw new LabFailure({ code: "ATTACHMENT_INVALID" });
      const bytes = await fileBytes(root, relativeStoredPath(stored.path, storedRoot));
      if (stored.size !== bytes.length || stored.sha256 !== sha256(bytes))
        throw new LabFailure({ code: "ATTACHMENT_INVALID" });
      canonical.set(stored.id, stored);
      mapped++;
    }
    const messages = Schema.decodeUnknownSync(Schema.Array(MessageRow))(
      db.prepare("SELECT thread_id,message_id,message_json FROM projection_thread_messages").all(),
    );
    const referencedRows = new Set<string>();
    for (const row of messages) {
      const message = Schema.decodeUnknownSync(Message)(JSON.parse(row.message_json));
      if (message.id !== row.message_id) throw new LabFailure({ code: "RELATIONSHIP_INVALID" });
      for (const summary of message.attachments) {
        const id = `${row.thread_id}:${row.message_id}:${summary.id}`;
        const indexed = attachments.find((item) => item.attachment_id === id);
        const stored = canonical.get(summary.id);
        if (
          indexed?.owner_kind !== "thread-message" ||
          indexed.owner_id !== `${row.thread_id}:${row.message_id}` ||
          indexed.path !== "" ||
          !stored ||
          stored.ownerThreadId !== row.thread_id ||
          stored.size !== summary.size
        )
          throw new LabFailure({ code: "ATTACHMENT_INVALID" });
        const indexedSummary = Schema.decodeUnknownSync(Summary)(JSON.parse(indexed.metadata_json));
        if (JSON.stringify(indexedSummary) !== JSON.stringify(summary))
          throw new LabFailure({ code: "ATTACHMENT_INVALID" });
        referencedRows.add(id);
      }
    }
    if (attachments.some((row) => row.owner_kind !== "generated" && !referencedRows.has(row.attachment_id)))
      throw new LabFailure({ code: "ATTACHMENT_INVALID" });
    const owners = Schema.decodeUnknownSync(Schema.Array(OwnerRow))(
      shared.prepare("SELECT table_name,owner_agent_id FROM openbot_metadata").all(),
    );
    for (const owner of owners) {
      if (
        !agentIds.has(owner.owner_agent_id) ||
        !shared.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(owner.table_name)
      )
        throw new LabFailure({ code: "SHARED_OWNER_INVALID" });
    }
    return mapped;
  } finally {
    db.close();
    shared?.close();
  }
}

export class SyntheticSnapshotLab {
  readonly #paths: Readonly<{ base: string; source: string; snapshot: string; target: string }>;
  get paths() {
    return this.#paths;
  }
  #childBaseline: ReturnType<typeof databaseInventory> | null = null;
  #stopped = false;
  #manifestDigest: string | null = null;
  private constructor(base: string) {
    this.#paths = Object.freeze({
      base,
      source: join(base, "source"),
      snapshot: join(base, "snapshot"),
      target: join(base, "target"),
    });
  }

  static readonly create = Effect.fn("SyntheticSnapshotLab.create")(function* () {
    return yield* Effect.tryPromise({
      try: async () => {
        const reportRoot = resolve(import.meta.dirname, "../../.openbot-build/instance-migration-rehearsal");
        await mkdir(reportRoot, { recursive: true, mode: 0o700 });
        const lab = new SyntheticSnapshotLab(await mkdtemp(join(reportRoot, "fixture-")));
        try {
          await mkdir(lab.paths.source, { mode: 0o700 });
          await writeSyntheticHouse(lab.paths.source);
          lab.#childBaseline = databaseInventory(lab.paths.source, "child-server/openbot.db");
          return lab;
        } catch (error) {
          await rm(lab.paths.base, { recursive: true, force: true });
          throw error;
        }
      },
      catch: failure,
    });
  });

  readonly stopSyntheticWriter = Effect.fn("SyntheticSnapshotLab.stopSyntheticWriter")(() =>
    Effect.sync(() => {
      this.#stopped = true;
    }),
  );

  readonly capture = Effect.fn("SyntheticSnapshotLab.capture")((fault: "none" | "copy-failure" = "none") =>
    Effect.tryPromise({
      try: async () => {
        if (!this.#stopped) throw new LabFailure({ code: "SOURCE_NOT_STOPPED" });
        const before = await inventory(this.#paths.source);
        await checkRelationships(this.#paths.source);
        const databases = before
          .filter((entry) => entry.kind === "file" && entry.path.endsWith(".db"))
          .map((entry) => databaseInventory(this.#paths.source, entry.path));
        const manifest: SnapshotManifest = {
          format: "openbot-synthetic-snapshot-lab",
          version: 1,
          fixtureId: this.#paths.base.split("/").at(-1) ?? "fixture",
          roots: [...ROOTS],
          entries: before,
          databases,
          credentials: CREDENTIALS,
          sourceVirtualRoot: "/synthetic-source",
          pathStatus: "mapping-only-no-rewrite",
          fullMigrationComplete: false,
        };
        await mkdir(this.#paths.snapshot, { mode: 0o700 });
        try {
          const tree = join(this.#paths.snapshot, "tree");
          await mkdir(tree, { mode: 0o700 });
          await this.#copy(this.#paths.source, tree, before, fault === "copy-failure");
          if (JSON.stringify(before) !== JSON.stringify(await inventory(this.#paths.source)))
            throw new LabFailure({ code: "SOURCE_CHANGED" });
          if (JSON.stringify(before) !== JSON.stringify(await inventory(tree)))
            throw new LabFailure({ code: "INVENTORY_MISMATCH" });
          const bytes = JSON.stringify(manifest);
          await writeFile(join(this.#paths.snapshot, "manifest.json"), bytes, { mode: 0o600, flag: "wx" });
          this.#manifestDigest = sha256(bytes);
          return manifest;
        } catch (error) {
          await rm(this.#paths.snapshot, { recursive: true, force: true });
          throw error;
        }
      },
      catch: failure,
    }),
  );

  async #copy(source: string, target: string, entries: readonly InventoryEntry[], failCopy = false): Promise<void> {
    for (const entry of entries) {
      relativePath(entry.path);
      const path = join(target, entry.path);
      if (entry.kind === "directory") await mkdir(path, { mode: 0o700 });
      else {
        const bytes = await fileBytes(source, entry.path);
        if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes)
          throw new LabFailure({ code: "SOURCE_CHANGED" });
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        if (failCopy) throw new LabFailure({ code: "FIXTURE_IO" });
      }
    }
    for (const entry of [...entries].reverse()) await chmod(join(target, entry.path), entry.mode);
  }

  async #verifiedSnapshot() {
    if (!this.#manifestDigest) throw new LabFailure({ code: "NO_SNAPSHOT" });
    const bytes = await readFile(join(this.#paths.snapshot, "manifest.json"));
    let manifest: SnapshotManifest;
    try {
      manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new LabFailure({ code: "INVALID_MANIFEST" });
    }
    for (const entry of manifest.entries) relativePath(entry.path);
    if (sha256(bytes) !== this.#manifestDigest) throw new LabFailure({ code: "SNAPSHOT_CHANGED" });
    const tree = join(this.#paths.snapshot, "tree");
    if (JSON.stringify(await inventory(tree)) !== JSON.stringify(manifest.entries))
      throw new LabFailure({ code: "INVENTORY_MISMATCH" });
    const databases = manifest.databases.map((item) => databaseInventory(tree, item.path));
    if (JSON.stringify(databases) !== JSON.stringify(manifest.databases))
      throw new LabFailure({ code: "DATABASE_INVALID" });
    const pathsVerified = await checkRelationships(tree);
    return { manifest, tree, databases, pathsVerified };
  }

  readonly restoreOffline = Effect.fn("SyntheticSnapshotLab.restoreOffline")(() =>
    Effect.tryPromise({
      try: async () => {
        const { manifest, tree, databases, pathsVerified } = await this.#verifiedSnapshot();
        if ((await readdir(this.#paths.base)).includes("target")) throw new LabFailure({ code: "TARGET_NOT_EMPTY" });
        const stage = await mkdtemp(join(this.#paths.base, "stage-"));
        try {
          await this.#copy(tree, stage, manifest.entries);
          if (JSON.stringify(await inventory(stage)) !== JSON.stringify(manifest.entries))
            throw new LabFailure({ code: "INVENTORY_MISMATCH" });
          await checkRelationships(stage);
          await rename(stage, this.#paths.target);
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
        return {
          syntheticOnly: true,
          inventoryVerified: true,
          offlineRestoreVerified: true,
          files: manifest.entries.filter((item) => item.kind === "file").length,
          directories: manifest.entries.filter((item) => item.kind === "directory").length,
          databases: databases.length,
          tables: databases.reduce((sum, item) => sum + item.tables.length, 0),
          pathsVerified,
          pathStatus: manifest.pathStatus,
          credentials: manifest.credentials,
          fullMigrationComplete: false,
          productionStartupPermitted: false,
          schedulerConstructed: false,
          providerStarted: false,
        };
      },
      catch: failure,
    }),
  );

  readonly restoreRelocatedOffline = Effect.fn("SyntheticSnapshotLab.restoreRelocatedOffline")(
    (
      fault:
        | "none"
        | "during-transaction"
        | "after-transform"
        | "unexpected-edit"
        | "unexpected-schema-edit"
        | "unexpected-sequence-edit" = "none",
    ) =>
      Effect.tryPromise({
        try: async () => {
          const sourceBefore = JSON.stringify(await inventory(this.#paths.source));
          const { manifest, tree } = await this.#verifiedSnapshot();
          const snapshotBefore = JSON.stringify(await inventory(tree));
          if ((await readdir(this.#paths.base)).includes("target")) throw new LabFailure({ code: "TARGET_NOT_EMPTY" });
          const stage = await mkdtemp(join(this.#paths.base, "relocation-stage-"));
          let published = false;
          try {
            await this.#copy(tree, stage, manifest.entries);
            if (
              JSON.stringify(databaseInventory(stage, "child-server/openbot.db")) !==
              JSON.stringify(this.#childBaseline)
            )
              throw new LabFailure({ code: "PATH_RELOCATION_UNSUPPORTED" });
            const scalarsChanged = await relocateSyntheticDatabase(
              stage,
              this.#paths.target,
              fault === "during-transaction",
            );
            if (fault === "after-transform") throw new LabFailure({ code: "FIXTURE_IO" });
            if (
              fault === "unexpected-edit" ||
              fault === "unexpected-schema-edit" ||
              fault === "unexpected-sequence-edit"
            ) {
              const db = new DatabaseSync(join(stage, "userdata/openbot.db"));
              try {
                if (fault === "unexpected-edit")
                  db.exec("UPDATE projection_threads SET title='unexpected fixture mutation'");
                if (fault === "unexpected-schema-edit")
                  db.exec("CREATE INDEX synthetic_unexpected ON projection_agents(model)");
                if (fault === "unexpected-sequence-edit")
                  db.exec("UPDATE sqlite_sequence SET seq=seq+100 WHERE name='orchestration_events'");
              } finally {
                db.close();
              }
            }
            const normalized = manifest.databases.map((item) =>
              databaseInventory(stage, item.path, this.#paths.target),
            );
            if (JSON.stringify(normalized) !== JSON.stringify(manifest.databases))
              throw new LabFailure({ code: "PATH_PROOF_FAILED" });
            const destination = await inventory(stage);
            if (
              destination.find((entry) => entry.path === "userdata/openbot.db")?.mode !==
              manifest.entries.find((entry) => entry.path === "userdata/openbot.db")?.mode
            )
              throw new LabFailure({ code: "PATH_PROOF_FAILED" });
            const unchanged = (entries: readonly InventoryEntry[]) =>
              entries.filter((entry) => entry.path !== "userdata/openbot.db");
            if (JSON.stringify(unchanged(destination)) !== JSON.stringify(unchanged(manifest.entries)))
              throw new LabFailure({ code: "PATH_PROOF_FAILED" });
            const pathsVerified = await checkRelationships(stage, this.#paths.target);
            await rename(stage, this.#paths.target);
            published = true;
            await checkRelationships(this.#paths.target, this.#paths.target);
            await this.#assertOriginals(sourceBefore, snapshotBefore, tree);
            return {
              syntheticOnly: true,
              pathStatus: "synthetic-allowlist-relocated",
              scalarsChanged,
              pathsVerified,
              destinationInventory: destination,
              originalSnapshotRetained: true,
              credentials: manifest.credentials,
              fullAppStartupTested: false,
              fullAppStartupBlocked: true,
              duplicateExecutionProven: false,
              fullMigrationComplete: false,
              productionStartupPermitted: false,
            };
          } catch (error) {
            // Only this lab's newly published target can be removed; no pre-existing target is accepted.
            if (published) await rm(this.#paths.target, { recursive: true, force: true });
            await this.#assertOriginals(sourceBefore, snapshotBefore, tree);
            throw error;
          } finally {
            await rm(stage, { recursive: true, force: true });
          }
        },
        catch: failure,
      }),
  );

  async #assertOriginals(sourceBefore: string, snapshotBefore: string, tree: string): Promise<void> {
    if (
      sourceBefore !== JSON.stringify(await inventory(this.#paths.source)) ||
      snapshotBefore !== JSON.stringify(await inventory(tree)) ||
      sha256(await readFile(join(this.#paths.snapshot, "manifest.json"))) !== this.#manifestDigest
    )
      throw new LabFailure({ code: "PATH_PROOF_FAILED" });
  }

  readonly dispose = Effect.fn("SyntheticSnapshotLab.dispose")(() =>
    Effect.tryPromise({ try: () => rm(this.#paths.base, { recursive: true, force: true }), catch: failure }),
  );
}
