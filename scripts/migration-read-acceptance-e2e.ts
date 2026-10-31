// Generates its own closed database. No caller-supplied profile, app startup or real credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { buildAcceptanceReader } from "./migration-read-acceptance/bundle";
import { createReadAcceptanceFixture, READ_ACCEPTANCE_TEXT } from "./migration-read-acceptance/fixture";

const reportRoot = resolve(import.meta.dirname, "../.openbot-build/migration-read-acceptance");
const ReaderResult = Schema.Struct({
  scope: Schema.Literal("actual-conversation-read-controller"),
  messages: Schema.Literal(4),
  attachments: Schema.Literal(1),
  routineRuns: Schema.Literal(0),
  databaseWriteDenied: Schema.Literal(true),
  fixtureWriteDenied: Schema.Literal(true),
  externalInterfaces: Schema.Literal(0),
  actualReadControllerExecuted: Schema.Literal(true),
  fullAppStartupTested: Schema.Literal(false),
  realCredentialsVerified: Schema.Literal(false),
  duplicateExecutionProven: Schema.Literal(false),
  fullMigrationComplete: Schema.Literal(false),
});
const results: Array<typeof ReaderResult.Type> = [];
const faultRefusals: string[] = [];
const ownedContainers = new Set<string>();
let timedOutFixtureCleaned = false;
let unchanged = false;
let graphRefusal = false;
let bundledModules = 0;
let fixture: Effect.Success<ReturnType<typeof createReadAcceptanceFixture>> | null = null;

async function fingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name);
      const stat = await lstat(file);
      assert.ok(stat.isDirectory() || stat.isFile());
      hash.update(JSON.stringify([file.slice(root.length), stat.mode & 0o777, stat.isDirectory()]));
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

function runReader(pack: string, waitForTimeout = false) {
  const name = `openbot-synthetic-read-${randomUUID()}`;
  ownedContainers.add(name);
  try {
    return spawnSync(
      "docker",
      [
        "run",
        "--name",
        name,
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
        "node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c",
        "node",
        ...(waitForTimeout
          ? ["--eval", 'process.stdout.write("SYNTHETIC_WAIT_READY\\n"); setInterval(() => {}, 1000);']
          : ["/fixture/reader.mjs"]),
      ],
      { encoding: "utf8", timeout: waitForTimeout ? 3000 : 60_000, killSignal: "SIGKILL" },
    );
  } finally {
    // A killed Docker CLI can leave its container alive. Remove only this generated owner.
    spawnSync("docker", ["container", "rm", "--force", name], {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const remaining = spawnSync("docker", ["container", "ls", "--all", "--quiet", "--filter", `name=${name}`], {
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    assert.equal(remaining.status, 0, "OWNED_CONTAINER_CLEANUP_UNVERIFIED");
    assert.equal(remaining.stdout.trim(), "", "OWNED_CONTAINER_CLEANUP_UNVERIFIED");
    ownedContainers.delete(name);
  }
}

try {
  assert.equal(process.argv.length, 2);
  fixture = await Effect.runPromise(createReadAcceptanceFixture());
  const { paths, ids } = fixture;
  assert.ok(Object.isFrozen(paths) && Object.isFrozen(ids));
  const baseline = await fingerprint(paths.source);
  assert.equal(await fingerprint(paths.target), baseline);
  const pack = join(paths.base, "reader-pack");
  await mkdir(pack, { mode: 0o755 });
  bundledModules = await buildAcceptanceReader(pack);
  try {
    await buildAcceptanceReader(join(paths.base, "forbidden-pack"), true);
  } catch (error) {
    graphRefusal = error instanceof Error && error.message.includes("READ_GRAPH_SOURCE_REFUSED");
  }
  assert.equal(graphRefusal, true);
  await cp(paths.target, join(pack, "tree"), { recursive: true, force: false, errorOnExist: true });
  await writeFile(
    join(pack, "config.json"),
    JSON.stringify({
      format: "openbot-synthetic-read-acceptance",
      ids,
      storedRoot: paths.source,
      storedAttachmentPath: paths.attachment,
      attachmentSha256: createHash("sha256").update(READ_ACCEPTANCE_TEXT.attachment).digest("hex"),
    }),
    { flag: "wx" },
  );
  await makeReadable(pack);
  const packBaseline = await fingerprint(pack);
  for (let start = 0; start < 2; start++) {
    const run = runReader(pack);
    assert.equal(run.status, 0, "RESTRICTED_READ_ACCEPTANCE_FAILED");
    results.push(Schema.decodeUnknownSync(ReaderResult)(JSON.parse(run.stdout.trim())));
  }
  // An intentional timeout, after a fixed ready marker, must leave no owned container.
  const timedOut = runReader(pack, true);
  assert.equal(timedOut.status, null);
  assert.ok(timedOut.error && "code" in timedOut.error);
  assert.equal(timedOut.error.code, "ETIMEDOUT");
  assert.equal(timedOut.stdout, "SYNTHETIC_WAIT_READY\n");
  assert.equal(ownedContainers.size, 0);
  timedOutFixtureCleaned = true;
  for (const fault of ["missing-database", "pending-wal", "missing-attachment", "invalid-message"]) {
    const faultPack = join(paths.base, `fault-${fault}`);
    await cp(pack, faultPack, { recursive: true, force: false, errorOnExist: true });
    const faultDatabase = join(faultPack, "tree/userdata/openbot.db");
    if (fault === "missing-database") await rm(faultDatabase);
    if (fault === "pending-wal") await writeFile(`${faultDatabase}-wal`, "synthetic-incomplete-snapshot");
    if (fault === "missing-attachment") await rm(join(faultPack, "tree", relative(paths.source, paths.attachment)));
    if (fault === "invalid-message") {
      await chmod(faultDatabase, 0o600);
      const db = new DatabaseSync(faultDatabase);
      try {
        db.prepare(
          "UPDATE projection_thread_messages SET message_json = json_set(message_json, '$.author', 'unsupported') WHERE message_id = ?",
        ).run(ids.userMessageId);
      } finally {
        db.close();
      }
    }
    await makeReadable(faultPack);
    const before = await fingerprint(faultPack);
    const run = runReader(faultPack);
    assert.equal(run.status, 78, "EXPECTED_READ_REFUSAL");
    assert.equal(run.signal, null);
    assert.equal(run.error, undefined);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "SYNTHETIC_READ_ACCEPTANCE_REFUSED\n");
    assert.equal(await fingerprint(faultPack), before);
    faultRefusals.push(fault);
  }
  unchanged =
    (await fingerprint(paths.source)) === baseline &&
    (await fingerprint(paths.target)) === baseline &&
    (await fingerprint(pack)) === packBaseline;
  assert.equal(unchanged, true);
} catch {
  process.exitCode = 1;
} finally {
  // Retain synthetic mounts if the daemon could not confirm that their reader was removed.
  if (fixture && ownedContainers.size === 0) await Effect.runPromise(fixture.dispose);
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  const report = {
    passed:
      results.length === 2 &&
      faultRefusals.length === 4 &&
      unchanged &&
      graphRefusal &&
      timedOutFixtureCleaned &&
      ownedContainers.size === 0,
    readerStarts: results.length,
    results,
    graphRefusal,
    faultRefusals,
    timedOutFixtureCleaned,
    pendingOwnedContainers: [...ownedContainers],
    bundledModules,
    sourceTargetAndReaderPackUnchanged: unchanged,
    fullAppStartupAdmitted: false,
    fullAppStartupTested: false,
    eventReplayTested: false,
    realCredentialsVerified: false,
    duplicateExecutionProven: false,
    fullMigrationComplete: false,
  };
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  // Machine-readable: fixed synthetic acceptance facts only; no private errors or stored paths.
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
