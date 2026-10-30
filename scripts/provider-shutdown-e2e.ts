// Quit must stop several provider processes that ignore SIGTERM without waiting out the 10 s
// agent-service step. Pi used to stop those processes one after another, and each waited 3 s.
// `bun run test:provider-shutdown`. Writes .openbot-build/provider-shutdown-e2e/report.json.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { PiAgentClient } from "../src/backend/pi-client";

const OUT = resolve(import.meta.dirname, "../.openbot-build/provider-shutdown-e2e");
const THREADS = 4;
const STOP_LIMIT_MS = 6_000;

const report: { passed: boolean; threads?: number; stopMs?: number; error?: string } = { passed: false };
const root = await mkdtemp(join(tmpdir(), "openbot-provider-shutdown-"));
const executable = join(root, "pi-fake");
const workspace = join(root, "workspace");

await mkdir(workspace);
await writeFile(
  executable,
  `#!/usr/bin/env node
const { join } = require("node:path");
const { tmpdir } = require("node:os");
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
const sessionFile = join(tmpdir(), "openbot-pi-fake-" + process.pid + ".json");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      const message = JSON.parse(line);
      const data = message.type === "get_state" ? { sessionFile } : {};
      process.stdout.write(JSON.stringify({ type: "response", id: message.id, success: true, data }) + "\\n");
    }
    newline = buffer.indexOf("\\n");
  }
});
setInterval(() => {}, 60_000);
`,
);
await chmod(executable, 0o755);

const client = new PiAgentClient({ executable, version: "0.0.0" }, { requestTimeoutMs: 10_000 });
client.start();

try {
  for (let index = 0; index < THREADS; index += 1) {
    await runCauseEffect(client.request("thread/start", { cwd: workspace }, (value) => value));
  }
  const startedAt = Date.now();
  await runCauseEffect(client.stop());
  report.stopMs = Date.now() - startedAt;
  report.threads = THREADS;
  assert.ok(report.stopMs < STOP_LIMIT_MS, `Stopping ${THREADS} provider processes took ${report.stopMs} ms.`);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(client.stop()).catch(() => {});
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
