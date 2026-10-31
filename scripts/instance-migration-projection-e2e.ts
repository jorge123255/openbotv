// No app startup. The only host process started is a restricted reader of generated synthetic data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { SyntheticSnapshotLab } from "./migration-lab/snapshot-store";

const reportRoot = resolve(import.meta.dirname, "../.openbot-build/instance-migration-projection-e2e");
const ReaderResult = Schema.Struct({
  scope: Schema.Literal("restricted-synthetic-projection"),
  databaseWriteDenied: Schema.Literal(true),
  fixtureWriteDenied: Schema.Literal(true),
  externalInterfaces: Schema.Literal(0),
  agents: Schema.Literal(1),
  messages: Schema.Literal(1),
  attachments: Schema.Literal(1),
  sharedTables: Schema.Literal(1),
  routineRuns: Schema.Literal(0),
  fullAppStartupTested: Schema.Literal(false),
  realCredentialsVerified: Schema.Literal(false),
  duplicateExecutionProven: Schema.Literal(false),
  fullMigrationComplete: Schema.Literal(false),
});
let lab: SyntheticSnapshotLab | null = null;
const results: Array<typeof ReaderResult.Type> = [];
let unchanged = false;

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name);
      const stat = await lstat(file);
      hash.update(file.slice(root.length));
      if (stat.isDirectory()) await visit(file);
      else hash.update(await readFile(file));
    }
  }
  await visit(root);
  return hash.digest("hex");
}
async function makeReadable(path: string): Promise<void> {
  const stat = await lstat(path);
  assert.ok(stat.isDirectory() || stat.isFile());
  await chmod(path, stat.isDirectory() ? 0o755 : 0o444);
  if (stat.isDirectory()) for (const name of await readdir(path)) await makeReadable(join(path, name));
}

try {
  assert.equal(process.argv.length, 2);
  lab = await Effect.runPromise(SyntheticSnapshotLab.create());
  await Effect.runPromise(lab.stopSyntheticWriter());
  await Effect.runPromise(lab.capture());
  await Effect.runPromise(lab.restoreRelocatedOffline());
  const baseline = [
    await fingerprint(lab.paths.source),
    await fingerprint(lab.paths.snapshot),
    await fingerprint(lab.paths.target),
  ];
  const pack = join(lab.paths.base, "projection-pack");
  await mkdir(pack, { mode: 0o755 });
  await cp(lab.paths.target, join(pack, "tree"), { recursive: true, force: false, errorOnExist: true });
  await writeFile(
    join(pack, "config.json"),
    JSON.stringify({
      format: "openbot-synthetic-projection-only",
      storedRoot: lab.paths.target,
      fullAppStartupAllowed: false,
    }),
  );
  await makeReadable(pack);
  for (let start = 0; start < 2; start++) {
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--user=1000:1000",
        "--memory=256m",
        "--cpus=1",
        "--pids-limit=64",
        "--env=HOME=/nonexistent",
        "--mount",
        `type=bind,src=${pack},dst=/fixture,readonly`,
        "--mount",
        `type=bind,src=${resolve(import.meta.dirname, "migration-lab/projection-reader.mjs")},dst=/reader.mjs,readonly`,
        "node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c",
        "node",
        "/reader.mjs",
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(run.status, 0, "Restricted projection failed; no full app startup was attempted.");
    results.push(Schema.decodeUnknownSync(ReaderResult)(JSON.parse(run.stdout.trim())));
  }
  unchanged =
    JSON.stringify(baseline) ===
    JSON.stringify([
      await fingerprint(lab.paths.source),
      await fingerprint(lab.paths.snapshot),
      await fingerprint(lab.paths.target),
    ]);
  assert.equal(unchanged, true);
} catch {
  process.exitCode = 1;
} finally {
  if (lab) await Effect.runPromise(lab.dispose());
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  const report = {
    passed: results.length === 2 && unchanged,
    readerStarts: results.length,
    results,
    sourceSnapshotTargetUnchanged: unchanged,
    fullAppStartupBlocked: true,
    fullAppStartupTested: false,
    realCredentialsVerified: false,
    duplicateExecutionProven: false,
    fullMigrationComplete: false,
  };
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  // Machine-readable: only fixed reader results and status are emitted.
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
