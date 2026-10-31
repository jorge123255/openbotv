// Generated fixtures only. No application startup or real credential path is accepted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Result, Schema } from "effect";
import type { LabFailure } from "./migration-lab/snapshot-model";
import { SyntheticSnapshotLab } from "./migration-lab/snapshot-store";

const reportRoot = resolve(import.meta.dirname, "../.openbot-build/instance-migration-path-e2e");
const handles: SyntheticSnapshotLab[] = [];
const groups: Array<{ name: string; passed: boolean }> = [];
const StringValue = Schema.Struct({ value: Schema.String });

async function create() {
  const lab = await Effect.runPromise(SyntheticSnapshotLab.create());
  handles.push(lab);
  await Effect.runPromise(lab.stopSyntheticWriter());
  return lab;
}
function sql(root: string, query: string) {
  const db = new DatabaseSync(join(root, "userdata/openbot.db"));
  try {
    db.exec(query);
  } finally {
    db.close();
  }
}
function value(root: string, query: string): string {
  const db = new DatabaseSync(join(root, "userdata/openbot.db"), { readOnly: true });
  try {
    return Schema.decodeUnknownSync(StringValue)(db.prepare(query).get()).value;
  } finally {
    db.close();
  }
}
async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const entry = join(path, name);
      const stat = await lstat(entry);
      hash.update(entry.slice(root.length));
      hash.update(String(stat.mode & 0o777));
      if (stat.isDirectory()) await walk(entry);
      else hash.update(await readFile(entry));
    }
  }
  await walk(root);
  return hash.digest("hex");
}
async function reject<A>(operation: Effect.Effect<A, LabFailure>, code: LabFailure["code"]): Promise<void> {
  const result = await Effect.runPromise(Effect.result(operation));
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.code, code);
}
async function check(name: string, action: () => Promise<void>) {
  try {
    await action();
    groups.push({ name, passed: true });
  } catch {
    groups.push({ name, passed: false });
  }
  // Machine-readable: fixed names and status only.
  process.stdout.write(`${groups.at(-1)?.passed ? "pass" : "FAIL"} ${name}\n`);
}

try {
  assert.equal(process.argv.length, 2);
  await check("allowlist-relocates-final-paths-and-preserves-all-other-data", async () => {
    const lab = await create();
    sql(
      lab.paths.source,
      "UPDATE projection_agents SET agent_json=json_set(agent_json,'$.futureField','retain me'); UPDATE projection_thread_messages SET message_json=json_set(message_json,'$.text','Quoted /synthetic-source/workspace/agent-lab stays unchanged')",
    );
    await Effect.runPromise(lab.capture());
    const before = [await fingerprint(lab.paths.source), await fingerprint(lab.paths.snapshot)];
    const result = await Effect.runPromise(lab.restoreRelocatedOffline());
    assert.equal(result.scalarsChanged, 3);
    assert.equal(result.pathsVerified, 2);
    assert.equal(result.fullMigrationComplete, false);
    assert.equal(result.fullAppStartupBlocked, true);
    assert.equal(result.duplicateExecutionProven, false);
    const workspace = value(
      lab.paths.target,
      "SELECT json_extract(agent_json,'$.workspacePath') AS value FROM projection_agents",
    );
    assert.equal(workspace, `${lab.paths.target}/workspace/agent-lab`);
    assert.ok((await lstat(workspace)).isDirectory());
    const attachment = value(
      lab.paths.target,
      "SELECT path AS value FROM projection_attachments WHERE owner_kind='generated'",
    );
    assert.equal(attachment, `${lab.paths.target}/shared/Transfers/generated-lab/report.txt`);
    assert.ok((await lstat(attachment)).isFile());
    assert.equal(
      value(lab.paths.target, "SELECT json_extract(agent_json,'$.providerAccountId') AS value FROM projection_agents"),
      "account-lab",
    );
    assert.equal(
      value(lab.paths.target, "SELECT json_extract(agent_json,'$.futureField') AS value FROM projection_agents"),
      "retain me",
    );
    assert.equal(
      value(lab.paths.target, "SELECT path AS value FROM projection_attachments WHERE owner_kind='thread-message'"),
      "",
    );
    assert.match(
      value(lab.paths.target, "SELECT json_extract(message_json,'$.text') AS value FROM projection_thread_messages"),
      /Quoted \/synthetic-source/,
    );
    assert.deepEqual(before, [await fingerprint(lab.paths.source), await fingerprint(lab.paths.snapshot)]);
  });
  for (const [fault, code] of [
    ["during-transaction", "FIXTURE_IO"],
    ["after-transform", "FIXTURE_IO"],
    ["unexpected-edit", "PATH_PROOF_FAILED"],
    ["unexpected-schema-edit", "PATH_PROOF_FAILED"],
    ["unexpected-sequence-edit", "PATH_PROOF_FAILED"],
  ] as const) {
    await check(`${fault}-keeps-originals-and-removes-target-stage`, async () => {
      const lab = await create();
      await Effect.runPromise(lab.capture());
      const before = [await fingerprint(lab.paths.source), await fingerprint(lab.paths.snapshot)];
      await reject(lab.restoreRelocatedOffline(fault), code);
      assert.ok(
        !(await readdir(lab.paths.base)).some((name) => name === "target" || name.startsWith("relocation-stage-")),
      );
      assert.deepEqual(before, [await fingerprint(lab.paths.source), await fingerprint(lab.paths.snapshot)]);
      assert.equal((await Effect.runPromise(lab.restoreRelocatedOffline())).scalarsChanged, 3);
    });
  }
  await check("wrong-root-category-is-not-globally-replaced", async () => {
    const lab = await create();
    sql(
      lab.paths.source,
      "UPDATE projection_agents SET agent_json=json_set(agent_json,'$.workspacePath','/synthetic-source/shared')",
    );
    await Effect.runPromise(lab.capture());
    await reject(lab.restoreRelocatedOffline(), "UNSAFE_PATH");
  });
  await check("source-prefix-lookalike-and-traversal-refused", async () => {
    const lab = await create();
    sql(
      lab.paths.source,
      "UPDATE projection_agents SET agent_json=json_set(agent_json,'$.workspacePath','/synthetic-source-other/workspace/agent-lab')",
    );
    await reject(lab.capture(), "UNSAFE_PATH");
    sql(
      lab.paths.source,
      "UPDATE projection_agents SET agent_json=json_set(agent_json,'$.workspacePath','/synthetic-source/workspace/../../outside')",
    );
    await reject(lab.capture(), "UNSAFE_PATH");
  });
  await check("unhandled-deletion-paths-block-partial-relocation", async () => {
    const lab = await create();
    sql(
      lab.paths.source,
      "INSERT INTO file_deletion_outbox(id,path,reason,created_at) VALUES ('delete-lab','/synthetic-source/workspace/agent-lab/notes.md','synthetic','2026-01-01')",
    );
    await Effect.runPromise(lab.capture());
    await reject(lab.restoreRelocatedOffline(), "PATH_RELOCATION_UNSUPPORTED");
  });
  await check("non-placeholder-event-payload-blocks-unverified-replay-paths", async () => {
    const lab = await create();
    sql(
      lab.paths.source,
      'UPDATE orchestration_events SET payload_json=\'{"path":"/synthetic-source/workspace/agent-lab"}\'',
    );
    await Effect.runPromise(lab.capture());
    await reject(lab.restoreRelocatedOffline(), "PATH_RELOCATION_UNSUPPORTED");
  });
  await check("preexisting-target-is-unchanged", async () => {
    const lab = await create();
    await Effect.runPromise(lab.capture());
    await mkdir(lab.paths.target);
    await writeFile(join(lab.paths.target, "keep.txt"), "keep");
    await reject(lab.restoreRelocatedOffline(), "TARGET_NOT_EMPTY");
    assert.equal(await readFile(join(lab.paths.target, "keep.txt"), "utf8"), "keep");
  });
  await check("populated-child-path-state-is-unsupported", async () => {
    const lab = await create();
    const child = new DatabaseSync(join(lab.paths.source, "child-server/openbot.db"));
    try {
      child.exec(
        "INSERT INTO file_deletion_outbox(id,path,reason,created_at) VALUES ('child-delete','/synthetic-source/workspace/file','synthetic','2026-01-01')",
      );
    } finally {
      child.close();
    }
    await Effect.runPromise(lab.capture());
    await reject(lab.restoreRelocatedOffline(), "PATH_RELOCATION_UNSUPPORTED");
  });
  await check("exposed-path-view-is-frozen-and-cannot-redirect-operations", async () => {
    const lab = await create();
    const original = lab.paths;
    assert.equal(Object.isFrozen(original), true);
    assert.throws(
      () => Object.defineProperty(original, "base", { value: join(original.base, "must-not-be-used") }),
      TypeError,
    );
    assert.equal(lab.paths.base, original.base);
    await Effect.runPromise(lab.capture());
    await Effect.runPromise(lab.restoreRelocatedOffline());
    assert.ok((await readdir(original.base)).includes("target"));
  });
} finally {
  for (const lab of handles) await Effect.runPromise(lab.dispose());
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(reportRoot, "report.json"),
    `${JSON.stringify({ syntheticOnly: true, groups, passed: groups.filter((group) => group.passed).length, fullAppStartupBlocked: true, duplicateExecutionProven: false, realCredentialsVerified: false, fullMigrationComplete: false }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (groups.length !== 13 || groups.some((group) => !group.passed)) process.exitCode = 1;
}
