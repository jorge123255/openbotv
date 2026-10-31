// Run the real backup service with synthetic files and injected host boundaries. On macOS, use
// an unprivileged Linux container with no network, no Docker socket and a read-only source mount.
// Linux CI runs the same fixture directly. No OpenBot instance or credential store is opened.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
];
const command = process.platform === "linux" ? "bash" : "docker";
const args =
  process.platform === "linux"
    ? [join(root, fixture), root]
    : [
        "run",
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
        "--mount",
        `type=bind,src=${root},dst=/repo,readonly`,
        "debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3",
        "bash",
        `/repo/${fixture}`,
        "/repo",
      ];

await mkdir(reportRoot, { recursive: true });
const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
const passed = result.stdout?.match(/^PASS .+$/gm)?.map((line) => line.slice(5)) ?? [];
const report = {
  finishedAt: new Date().toISOString(),
  harness: process.platform === "linux" ? "local-linux-boundaries-injected" : "isolated-linux-container",
  exitCode: result.status,
  passed,
  missing: expected.filter((name) => !passed.includes(name)),
};
await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(reportRoot, "fixture.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
// Machine-readable: only fixed scenario names and counts go to stdout.
process.stdout.write(`${JSON.stringify(report)}\n`);
assert.equal(result.status, 0, "Synthetic backup fixture failed; see fixture.log.");
assert.deepEqual(passed, expected);
