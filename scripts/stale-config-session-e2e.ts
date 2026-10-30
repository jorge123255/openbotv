// A gone ACP session must not fail the turn, and the recovered JSON-RPC line must not be logged as
// a provider failure. OpenRouter alias ids that start with `~` are valid. Grok hook WARN lines are
// notices. `bun run test:stale-config-session`. Writes .openbot-build/stale-config-session-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isAgentModel } from "@openbot/contracts/ipc";
import { isGrokHookLoadDiagnostic, isRecoveredAcpSessionDiagnostic } from "../src/backend/agent/provider-diagnostics";
import { isMissingProviderSessionError } from "../src/backend/agent/thread-items";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, startThread, stopClients } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/stale-config-session-e2e");
const report: { passed: boolean; missingSession?: boolean; error?: string } = { passed: false };
const root = await mkdtemp(join(tmpdir(), "openbot-stale-config-"));
const clients: import("../src/backend/agent-client").AgentClient[] = [];

try {
  assert.equal(isAgentModel("~anthropic/claude-sonnet-latest"), true);
  assert.equal(isAgentModel("~openai/gpt-latest"), true);
  assert.equal(isAgentModel(" anthropic/claude"), false);
  assert.equal(
    isGrokHookLoadDiagnostic(
      "2026-10-30T19:00:00.000Z WARN hooks: failed to load hook CursorHookNotRun async unsupported fields",
    ),
    true,
  );
  assert.equal(
    isGrokHookLoadDiagnostic("2026-10-30T19:00:00.000Z WARNING hooks: CursorHookNotRun async unsupported fields"),
    true,
  );
  assert.equal(
    isGrokHookLoadDiagnostic("2026-10-30T19:00:00.000Z ERROR hooks: CursorHookNotRun provider request failed"),
    false,
  );
  assert.equal(
    isRecoveredAcpSessionDiagnostic("2026-10-30T19:00:00.000Z ERROR acp: session/load -32016 Session not found"),
    true,
  );
  assert.equal(
    isRecoveredAcpSessionDiagnostic(
      "2026-10-30T19:00:00.000Z ERROR acp: session/set_config_option -32002 Session not found",
    ),
    true,
  );
  assert.equal(
    isRecoveredAcpSessionDiagnostic("2026-10-30T19:00:00.000Z ERROR acp: session/prompt -32603 Internal error"),
    false,
  );

  const executable = join(root, "bin", "grok");
  await installFakeAgent(executable, "conformance", { FAKE_CONFIG_GONE: "1" });
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const client = requireProviderDriver("grok").createClient(
    { executable, version: "99.0.0", source: "managed" },
    20_000,
    NO_PROVIDER_CREDENTIALS,
  );
  clients.push(client);
  client.start();
  const threadId = await startThread(client, { cwd: workspace });
  await runCauseEffect(client.stop());
  const resumed = requireProviderDriver("grok").createClient(
    { executable, version: "99.0.0", source: "managed" },
    20_000,
    NO_PROVIDER_CREDENTIALS,
  );
  clients.push(resumed);
  resumed.start();
  const missingSession = await runCauseEffect(
    resumed.request("thread/resume", { threadId, cwd: workspace, model: "fake-alpha" }, (value) => value),
  ).then(
    () => false,
    (error: unknown) => isMissingProviderSessionError(error, "grok"),
  );
  report.missingSession = missingSession;
  assert.equal(missingSession, true, "session/set_config_option -32002 Session not found opens a new session.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await stopClients(clients);
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
