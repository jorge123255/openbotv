// A dropped ACP provider stream is sent again before the turn fails, and a silent prompt that
// accepts cancel is sent again. A sign-in error, a stream that already produced text, and a silent
// prompt that ignores cancel are not sent again.
// `bun run test:stream-stall-retry`. Writes .openbot-build/stream-stall-retry-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { AcpAgentClient } from "../src/backend/acp-client";
import { DEFAULT_ACP_FLAVOR } from "../src/backend/acp-flavor";
import type { AgentClient } from "../src/backend/agent-client";
import {
  computeBackoffDelayMs,
  computeServerPacedDelayMs,
  isRetryableProviderError,
  MAX_SERVER_RETRY_AFTER_MS,
  runWithTransientRetry,
  serverRetryAfterMsFromError,
  shouldRetryTurnAttempt,
} from "../src/backend/transient-stream-error";
import { installFakeAgent, readJsonl, runTurn, startThread, stopClients, type TurnResult } from "./provider-fakes/host";

const OUT = resolve(import.meta.dirname, "../.openbot-build/stream-stall-retry-e2e");
const STALL_MS = 400;

interface LogEntry {
  event: string;
  sessionId?: string;
  text?: string;
}

interface PromptCase {
  text: string;
  prompts: number;
  status: string | null;
  error: string | null;
  reply: string;
}

interface Report {
  passed: boolean;
  policy?: {
    backoffMs: number;
    serverPacedMs: number;
    retries: number;
    authBlocked: boolean;
    outputBlocked: boolean;
    overflowBlocked: boolean;
  };
  cases?: PromptCase[];
  failure?: string;
}

function promptsFor(entries: readonly LogEntry[], text: string): number {
  return entries.filter((entry) => entry.event === "prompt" && entry.text === text).length;
}

async function checkPolicy(): Promise<NonNullable<Report["policy"]>> {
  const backoffMs = computeBackoffDelayMs({ attempt: 1, baseDelayMs: 1_000, maxDelayMs: 15_000, random: () => 0 });
  assert.equal(backoffMs, 500, "The first backoff is half the base delay when the jitter is zero.");
  const serverPacedMs = computeServerPacedDelayMs({ retryAfterMs: 2_000, random: () => 0 });
  assert.equal(serverPacedMs, 2_000, "A server retry-after with zero jitter waits that long.");
  assert.ok(serverPacedMs <= MAX_SERVER_RETRY_AFTER_MS, "A server retry-after stays within the cap.");

  const sleeps: number[] = [];
  const value = await runWithTransientRetry(
    (() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls < 3) return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
        return Promise.resolve("ok");
      };
    })(),
    {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 400,
      random: () => 0,
      sleep: (delayMs) => {
        sleeps.push(delayMs);
        return Promise.resolve();
      },
    },
  );
  assert.equal(value, "ok", "A transient stream error is sent again until the stream returns.");
  assert.equal(sleeps.length, 2, "Two failures use two waits.");

  const auth = Object.assign(new Error("authentication required"), { status: 401 });
  assert.equal(isRetryableProviderError(auth), false, "A sign-in error is not retryable.");
  assert.equal(
    shouldRetryTurnAttempt({
      canceled: false,
      error: new Error("socket hang up"),
      streamOutputProduced: true,
      resumeCheckpointAvailable: false,
    }),
    false,
    "Output with no checkpoint is not sent again.",
  );
  assert.equal(
    shouldRetryTurnAttempt({
      canceled: false,
      error: new Error("maximum prompt length is 8 and the request contains 9 tokens"),
      streamOutputProduced: false,
      resumeCheckpointAvailable: false,
    }),
    false,
    "A context overflow is not sent again.",
  );
  const paced = Object.assign(new Error("engine is currently overloaded"), {
    metadata: new Map([["retry-after", "2"]]),
  });
  assert.equal(isRetryableProviderError(paced), true, "An overloaded engine is retryable.");
  assert.equal(serverRetryAfterMsFromError(paced), 2_000, "A retry-after header sets the next wait.");
  return {
    backoffMs,
    serverPacedMs,
    retries: sleeps.length,
    authBlocked: true,
    outputBlocked: true,
    overflowBlocked: true,
  };
}

const root = await mkdtemp(join(tmpdir(), "openbot-stream-stall-retry-e2e-"));
const report: Report = { passed: false };
const clients: AgentClient[] = [];

try {
  report.policy = await checkPolicy();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const log = join(root, "agent.jsonl");
  const executable = join(root, "cline", "bin", "cline");
  await installFakeAgent(executable, "stream-stall", { FAKE_LOG: log });
  const client = new AcpAgentClient({ executable, version: "99.0.0", source: "managed" }, 20_000, {
    provider: "cline",
    flavor: DEFAULT_ACP_FLAVOR,
    argv: ["acp"],
    env: {},
    signInMessage: "Sign in to the fake agent.",
    turnStallMs: STALL_MS,
    streamRetry: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 40, random: () => 0 },
  });
  clients.push(client);
  client.start();
  const thread = await startThread(client, { cwd: workspace });

  const cases: Array<{ text: string; expect: (result: TurnResult, prompts: number) => void }> = [
    {
      text: "drop-once",
      expect: (result, prompts) => {
        assert.equal(prompts, 2, "A socket reset before any output is sent again.");
        assert.equal(result.status, "completed", "The retried stream completes.");
        assert.equal(result.reply, "recovered", "The answer is the successful stream only.");
        assert.equal(result.error, null, "A recovered stream reports no error.");
      },
    },
    {
      text: "overload-once",
      expect: (result, prompts) => {
        assert.equal(prompts, 2, "An overloaded engine is sent again.");
        assert.equal(result.status, "completed", "The overload retry completes.");
        assert.equal(result.reply, "recovered-overload", "The overload retry keeps the second answer.");
      },
    },
    {
      text: "auth",
      expect: (result, prompts) => {
        assert.equal(prompts, 1, "A sign-in error is not sent again.");
        assert.equal(result.status, "failed", "A sign-in error fails the turn.");
      },
    },
    {
      text: "drop-after-text",
      expect: (result, prompts) => {
        assert.equal(prompts, 1, "A stream that already sent text is not sent again.");
        assert.equal(result.status, "failed", "A dropped stream after text fails the turn.");
      },
    },
    {
      text: "drop-always",
      expect: (result, prompts) => {
        assert.equal(prompts, 4, "A stream that keeps failing stops after four attempts.");
        assert.equal(result.status, "failed", "The exhausted stream fails the turn.");
        assert.match(result.error ?? "", /socket hang up/u, "The turn keeps the provider error.");
      },
    },
    {
      text: "stall-once",
      expect: (result, prompts) => {
        assert.equal(prompts, 2, "A silent prompt that accepts cancel is sent again.");
        assert.equal(result.status, "completed", "The stall retry completes.");
        assert.equal(result.reply, "resumed", "The stall retry shows the second answer.");
        assert.equal(result.error, null, "A recovered stall reports no error.");
      },
    },
    {
      text: "hang",
      expect: (result, prompts) => {
        assert.equal(prompts, 1, "A silent prompt that ignores cancel is not sent again.");
        assert.equal(result.status, "failed", "A silent prompt that ignores cancel fails.");
        assert.equal(
          result.error,
          sourceText("error.agent.turnStalled", { provider: "Cline" }),
          "The failure stays the stall message.",
        );
      },
    },
  ];

  report.cases = [];
  for (const item of cases) {
    const result = await runTurn(client, thread, { text: item.text, timeoutMs: 15_000 });
    const prompts = promptsFor(await readJsonl<LogEntry>(log), item.text);
    report.cases.push({
      text: item.text,
      prompts,
      status: result.status,
      error: result.error,
      reply: result.reply,
    });
    item.expect(result, prompts);
  }

  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await stopClients(clients);
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
