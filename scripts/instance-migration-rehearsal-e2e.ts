// Creates its own synthetic house. No input path, user profile, provider or network is accepted.
import assert from "node:assert/strict";
import { link, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Result } from "effect";
import { type LabFailure, ROOTS } from "./migration-lab/snapshot-model";
import { SyntheticSnapshotLab } from "./migration-lab/snapshot-store";

const reportRoot = resolve(import.meta.dirname, "../.openbot-build/instance-migration-rehearsal");
const groups: Array<{ name: string; passed: boolean }> = [];
const handles: SyntheticSnapshotLab[] = [];
let verifiedFixture: {
  files: number;
  directories: number;
  databases: number;
  tables: number;
  pathsVerified: number;
} | null = null;

async function create() {
  const lab = await Effect.runPromise(SyntheticSnapshotLab.create());
  handles.push(lab);
  return lab;
}

async function prepared() {
  const lab = await create();
  await Effect.runPromise(lab.stopSyntheticWriter());
  await Effect.runPromise(lab.capture());
  return lab;
}

async function reject<A>(operation: Effect.Effect<A, LabFailure>, code: LabFailure["code"]): Promise<void> {
  const result = await Effect.runPromise(Effect.result(operation));
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.code, code);
  const publicFailure = result.failure.toJSON();
  assert.ok(publicFailure !== null && typeof publicFailure === "object");
  assert.deepEqual(Object.keys(publicFailure).sort(), ["_tag", "code"]);
}

function mutateDatabase(lab: SyntheticSnapshotLab, sql: string, shared = false): void {
  const path = shared ? "shared/Data/agent-data.db" : "userdata/openbot.db";
  const db = new DatabaseSync(join(lab.paths.source, path), { enableForeignKeyConstraints: false });
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

async function check(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
    groups.push({ name, passed: true });
  } catch {
    groups.push({ name, passed: false });
  }
  // Machine-readable: fixed labels only; exception text and data stay out of logs.
  process.stdout.write(`${groups.at(-1)?.passed ? "pass" : "FAIL"} ${name}\n`);
}

try {
  assert.equal(process.argv.length, 2, "This lab accepts no inputs.");
  await check("requires-stopped-synthetic-source", async () => {
    const lab = await create();
    await reject(lab.capture(), "SOURCE_NOT_STOPPED");
    assert.ok(!(await readdir(lab.paths.base)).includes("snapshot"));
  });
  await check("complete-fixture-inventory-and-offline-copy", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    const manifest = await Effect.runPromise(lab.capture());
    assert.deepEqual(manifest.roots, [...ROOTS]);
    assert.equal(manifest.databases.length, 3);
    assert.ok(
      manifest.databases.some((db) =>
        db.tables.some((table) => table.name === "orchestration_events" && table.rows === 1),
      ),
    );
    assert.ok(
      manifest.databases.some((db) =>
        db.tables.some((table) => table.name === "projection_provider_sessions" && table.rows === 1),
      ),
    );
    assert.ok(
      manifest.entries.some((entry) => entry.path === "workspace/agent-lab/empty" && entry.kind === "directory"),
    );
    const report = await Effect.runPromise(lab.restoreOffline());
    verifiedFixture = {
      files: report.files,
      directories: report.directories,
      databases: report.databases,
      tables: report.tables,
      pathsVerified: report.pathsVerified,
    };
    assert.equal(report.offlineRestoreVerified, true);
    assert.equal(report.pathsVerified, 2);
    assert.equal(report.credentials.apiKeys, "reauthentication-required");
    assert.equal(report.credentials.osKeychain, "unavailable");
    assert.equal(report.fullMigrationComplete, false);
    assert.equal(report.productionStartupPermitted, false);
    assert.equal(report.pathStatus, "mapping-only-no-rewrite");
    for (const entry of manifest.entries.filter((entry) => entry.kind === "file")) {
      assert.deepEqual(
        await readFile(join(lab.paths.target, entry.path)),
        await readFile(join(lab.paths.source, entry.path)),
      );
    }
    const db = new DatabaseSync(join(lab.paths.target, "userdata/openbot.db"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT agent_id FROM projection_agents").get()?.agent_id, "agent-lab");
      assert.equal(db.prepare("SELECT message_id FROM projection_thread_messages").get()?.message_id, "message-lab");
      assert.equal(
        db.prepare("SELECT resume_cursor FROM projection_provider_sessions").get()?.resume_cursor,
        "cursor-lab",
      );
      assert.deepEqual(
        db
          .prepare("SELECT active FROM projection_agent_routines ORDER BY routine_id")
          .all()
          .map((row) => row.active),
        [1, 0],
      );
      assert.equal(db.prepare("SELECT count(*) AS total FROM projection_routine_runs").get()?.total, 0);
      assert.equal(
        db.prepare("SELECT path FROM projection_attachments WHERE owner_kind='thread-message'").get()?.path,
        "",
      );
    } finally {
      db.close();
    }
  });
  await check("frozen-snapshot-survives-later-source-changes", async () => {
    const lab = await prepared();
    await writeFile(join(lab.paths.source, "workspace/agent-lab/notes.md"), "changed after snapshot");
    await Effect.runPromise(lab.restoreOffline());
    assert.match(await readFile(join(lab.paths.target, "workspace/agent-lab/notes.md"), "utf8"), /Keep quoted/);
  });
  await check("corrupt-file-refuses-restore-without-target-write", async () => {
    const lab = await prepared();
    await writeFile(join(lab.paths.snapshot, "tree/shared/Transfers/generated-lab/report.txt"), "damaged");
    await reject(lab.restoreOffline(), "INVENTORY_MISMATCH");
    assert.ok(!(await readdir(lab.paths.base)).includes("target"));
  });
  await check("extra-file-refuses-restore", async () => {
    const lab = await prepared();
    await writeFile(join(lab.paths.snapshot, "tree/workspace/extra.txt"), "extra");
    await reject(lab.restoreOffline(), "INVENTORY_MISMATCH");
  });
  await check("missing-file-refuses-restore", async () => {
    const lab = await prepared();
    await rm(join(lab.paths.snapshot, "tree/provider-home/session.json"));
    await reject(lab.restoreOffline(), "INVENTORY_MISMATCH");
  });
  await check("manifest-tampering-and-unknown-version-refused", async () => {
    const lab = await prepared();
    const path = join(lab.paths.snapshot, "manifest.json");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace('"version":1', '"version":999'));
    await reject(lab.restoreOffline(), "INVALID_MANIFEST");
    await writeFile(path, original.replace('"fixtureId":', '"untrusted":true,"fixtureId":'));
    await reject(lab.restoreOffline(), "SNAPSHOT_CHANGED");
  });
  await check("manifest-path-escape-refused", async () => {
    const lab = await prepared();
    const path = join(lab.paths.snapshot, "manifest.json");
    await writeFile(path, (await readFile(path, "utf8")).replace('"path":"browser"', '"path":"../outside"'));
    await reject(lab.restoreOffline(), "UNSAFE_PATH");
  });
  await check("target-is-never-replaced", async () => {
    const lab = await prepared();
    await mkdir(lab.paths.target);
    await writeFile(join(lab.paths.target, "keep.txt"), "keep");
    await reject(lab.restoreOffline(), "TARGET_NOT_EMPTY");
    assert.equal(await readFile(join(lab.paths.target, "keep.txt"), "utf8"), "keep");
  });
  await check("source-symlink-and-hardlink-refused", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    const path = join(lab.paths.source, "workspace/link");
    await symlink(join(lab.paths.source, "userdata/settings.json"), path);
    await reject(lab.capture(), "UNSUPPORTED_ENTRY");
    await rm(path);
    await link(join(lab.paths.source, "userdata/settings.json"), path);
    await reject(lab.capture(), "UNSUPPORTED_ENTRY");
  });
  await check("undeclared-root-and-portable-name-refused", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    await mkdir(join(lab.paths.source, "undeclared"));
    await reject(lab.capture(), "UNDECLARED_ROOT");
    await rm(join(lab.paths.source, "undeclared"), { recursive: true });
    await writeFile(join(lab.paths.source, "workspace/AUX.txt"), "unsupported portable name");
    await reject(lab.capture(), "UNSAFE_PATH");
  });
  await check("id-history-and-attachment-owner-corruption-refused", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    mutateDatabase(lab, "UPDATE projection_agents SET agent_json=json_set(agent_json,'$.id','replacement-id')");
    await reject(lab.capture(), "RELATIONSHIP_INVALID");
    mutateDatabase(
      lab,
      "UPDATE projection_agents SET agent_json=json_set(agent_json,'$.id','agent-lab'); UPDATE projection_attachments SET metadata_json=json_set(metadata_json,'$.ownerThreadId','missing-thread') WHERE owner_kind='generated'",
    );
    await reject(lab.capture(), "ATTACHMENT_INVALID");
  });
  await check("summary-must-resolve-to-stored-attachment", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    mutateDatabase(lab, "DELETE FROM projection_attachments WHERE owner_kind='generated'");
    await reject(lab.capture(), "ATTACHMENT_INVALID");
  });
  await check("shared-owner-and-stored-path-escape-refused", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    mutateDatabase(lab, "UPDATE openbot_metadata SET owner_agent_id='missing-agent'", true);
    await reject(lab.capture(), "SHARED_OWNER_INVALID");
    mutateDatabase(lab, "UPDATE openbot_metadata SET owner_agent_id='agent-lab'", true);
    mutateDatabase(
      lab,
      "UPDATE projection_agents SET agent_json=json_set(agent_json,'$.workspacePath','/synthetic-source/workspace/../../outside')",
    );
    await reject(lab.capture(), "UNSAFE_PATH");
  });
  await check("broken-session-foreign-key-refused", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    mutateDatabase(lab, "UPDATE projection_provider_sessions SET thread_id='missing-thread'");
    await reject(lab.capture(), "DATABASE_INVALID");
  });
  await check("contradictory-thread-ownership-refused", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    mutateDatabase(
      lab,
      "INSERT INTO projection_agents SELECT 'other-agent','thread-lab',model,updated_at,1,json_object('id','other-agent','threadId','thread-lab','workspacePath','/synthetic-source/workspace/agent-lab'),1 FROM projection_agents",
    );
    await reject(lab.capture(), "RELATIONSHIP_INVALID");
  });
  await check("failed-copy-cleans-stage-and-allows-retry", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    await reject(lab.capture("copy-failure"), "FIXTURE_IO");
    assert.ok(!(await readdir(lab.paths.base)).includes("snapshot"));
    await reject(lab.restoreOffline(), "NO_SNAPSHOT");
    await Effect.runPromise(lab.capture());
    assert.equal((await Effect.runPromise(lab.restoreOffline())).offlineRestoreVerified, true);
  });
  await check("attachment-agent-and-thread-must-have-same-owner", async () => {
    const lab = await create();
    await Effect.runPromise(lab.stopSyntheticWriter());
    mutateDatabase(
      lab,
      "INSERT INTO projection_threads(thread_id,agent_id,title,created_at,updated_at,last_event_sequence) VALUES ('other-thread','other-agent','Other','2026-01-01','2026-01-01',1); INSERT INTO projection_agents SELECT 'other-agent','other-thread',model,updated_at,1,json_object('id','other-agent','threadId','other-thread','workspacePath','/synthetic-source/workspace/agent-lab'),1 FROM projection_agents; UPDATE projection_attachments SET metadata_json=json_set(metadata_json,'$.ownerAgentId','other-agent') WHERE owner_kind='generated'",
    );
    await reject(lab.capture(), "ATTACHMENT_INVALID");
  });
} finally {
  for (const lab of handles) await Effect.runPromise(lab.dispose());
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  const report = {
    syntheticOnly: true,
    finishedAt: new Date().toISOString(),
    groups,
    verifiedFixture,
    passed: groups.filter((group) => group.passed).length,
    fullMigrationComplete: false,
    realCredentialsRead: false,
    productionStartupPermitted: false,
    pathRewriteImplemented: false,
  };
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (!groups.length || groups.some((group) => !group.passed)) process.exitCode = 1;
}
