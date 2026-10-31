// Run the real backup service with synthetic files and injected host boundaries. All platforms use
// an unprivileged networkless container with only two source files mounted read-only. No Docker
// socket, host home, OpenBot instance or credential store is exposed to the fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const reportRoot = join(root, ".openbot-build/instance-backup-stop-e2e");
const fixture = "scripts/instance-backup-stop-fixture.sh";
const expected = [
  "kept-stopped-success",
  "option-order",
  "kept-stopped-without-verify",
  "already-stopped",
  "copy-failure-stays-stopped",
  "verification-failure-stays-stopped",
  "unclean-stop-refused",
  "preflight-failure-keeps-running-state",
  "unknown-option-refused",
  "default-restarts",
  "default-failure-restarts",
  "default-unclean-stop-keeps-existing-policy",
  "credential-diagnostic-leak-refused",
  "missing-diagnostic-file-refused",
];
const sourceFiles = [fixture, "docker/instances/openbot-instance"];
const ownedContainers = new Set<string>();
let pack: string | null = null;
let exitCode: number | null = null;
let passed: string[] = [];
let fixtureLog = "SYNTHETIC_FIXTURE_NOT_COMPLETED\n";
let timedOutFixtureCleaned = false;
let complete = false;

async function sourcePack(): Promise<string> {
  const path = await mkdtemp(join(reportRoot, "source-"));
  pack = path;
  await chmod(path, 0o755);
  for (const file of sourceFiles) {
    const source = join(root, file);
    const stat = await lstat(source);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const target = join(path, file);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, await readFile(source), { mode: 0o444, flag: "wx" });
  }
  const files: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const name of await readdir(directory)) {
      const child = join(directory, name);
      const key = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(child);
      assert.ok(stat.isFile() || stat.isDirectory());
      if (stat.isDirectory()) await visit(child, key);
      else files.push(key);
    }
  }
  await visit(path);
  assert.deepEqual(files.sort(), [...sourceFiles].sort());
  return path;
}

function runOwned(path: string, waitForTimeout = false) {
  const name = `openbot-backup-fixture-${randomUUID()}`;
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
        "--pids-limit=128",
        "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777",
        "--env=HOME=/nonexistent",
        "--mount",
        `type=bind,src=${path},dst=/repo,readonly`,
        "debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3",
        "bash",
        ...(waitForTimeout
          ? ["-c", "printf 'SYNTHETIC_BACKUP_WAIT_READY\\n'; exec sleep 600"]
          : [`/repo/${fixture}`, "/repo"]),
      ],
      { encoding: "utf8", timeout: waitForTimeout ? 3000 : 60_000, killSignal: "SIGKILL" },
    );
  } finally {
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

await mkdir(reportRoot, { recursive: true, mode: 0o700 });
try {
  assert.equal(process.argv.length, 2, "This synthetic fixture accepts no input paths.");
  const path = await sourcePack();
  const result = runOwned(path);
  exitCode = result.status;
  const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const canaryInOutput = raw.includes("synthetic password");
  fixtureLog = canaryInOutput ? "SYNTHETIC_FIXTURE_OUTPUT_REFUSED\n" : raw;
  assert.equal(canaryInOutput, false);
  assert.equal(result.status, 0, "SYNTHETIC_BACKUP_FIXTURE_FAILED");
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  const labels = result.stdout.match(/^PASS .+$/gm)?.map((line) => line.slice(5)) ?? [];
  assert.deepEqual(labels, expected);
  passed = [...expected];
  const timedOut = runOwned(path, true);
  assert.equal(timedOut.status, null);
  assert.ok(timedOut.error && "code" in timedOut.error);
  assert.equal(timedOut.error.code, "ETIMEDOUT");
  assert.equal(timedOut.stdout, "SYNTHETIC_BACKUP_WAIT_READY\n");
  assert.equal(ownedContainers.size, 0);
  timedOutFixtureCleaned = true;
  complete = true;
} catch {
  process.exitCode = 1;
} finally {
  // Do not delete a potentially active mount when the daemon could not confirm cleanup.
  if (pack && ownedContainers.size === 0) await rm(pack, { recursive: true, force: true });
  const report = {
    finishedAt: new Date().toISOString(),
    harness: "isolated-linux-container",
    exitCode,
    passed,
    missing: expected.filter((name) => !passed.includes(name)),
    complete: complete && ownedContainers.size === 0,
    sourcePackFiles: sourceFiles,
    timedOutFixtureCleaned,
    pendingOwnedContainers: [...ownedContainers],
    ordinaryBackupEncrypted: false,
    migrationCredentialExportAvailable: false,
    realCredentialsVerified: false,
    duplicateExecutionProven: false,
  };
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(reportRoot, "fixture.log"), fixtureLog, { mode: 0o600 });
  // Machine-readable: only fixed scenario names and status; no paths or credential values.
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
