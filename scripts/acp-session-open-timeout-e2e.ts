// Real ACP process/SDK/bridge with an owned fake that holds session setup and returns late.
// node --import tsx scripts/acp-session-open-timeout-e2e.ts [--expect-baseline]
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { AcpAgentClient } from "../src/backend/acp-client";
import { DEFAULT_ACP_FLAVOR } from "../src/backend/acp-flavor";
import { isMissingProviderSessionError } from "../src/backend/agent/thread-items";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolNamespace } from "../src/backend/local-mcp-bridge";
import { decodeThreadResponse } from "../src/backend/protocol";
import type { ProviderHistoryFragment } from "../src/backend/provider-history";
import { TimeoutError } from "../src/backend/with-timeout";

const out = resolve(import.meta.dirname, "../.openbot-build/acp-session-open-timeout-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-acp-open-"));
const baseline = process.argv.includes("--expect-baseline");
const deadlineMs = 500;
const report: { passed: boolean; baseline: boolean; cases: string[]; observations: unknown[]; error?: string } = {
  passed: false,
  baseline,
  cases: [],
  observations: [],
};
interface WireEntry {
  event: string;
  method?: string;
  id?: number;
  requestId?: number;
  resultId?: string;
  server?: { url: string; headers: { name: string; value: string }[] };
}

async function entries(path: string): Promise<WireEntry[]> {
  return (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function logEntry(directory: string, path: string, ready: (entry: WireEntry) => boolean): Promise<WireEntry> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The synthetic ACP event did not arrive.")), 10_000);
    const watcher = watch(directory, () => void inspect());
    let ended = false;
    function finish(error?: Error, entry?: WireEntry) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else if (entry) resolve(entry);
    }
    async function inspect() {
      const found = (await entries(path)).find(ready);
      if (found) finish(undefined, found);
    }
    void inspect();
  });
}
const tools: DynamicToolNamespace[] = [
  {
    type: "namespace",
    name: "fixture",
    tools: [{ type: "function", name: "inspect", inputSchema: { type: "object" } }],
  },
];

async function scenario(method: "session/load" | "session/resume" | "session/new") {
  const directory = join(root, method.replace("/", "-"));
  await mkdir(directory);
  const control = join(directory, "control.json");
  const log = join(directory, "wire.jsonl");
  const executable = join(directory, "agent.cjs");
  await writeFile(control, JSON.stringify({ hold: "", release: false }));
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const CONTROL = ${JSON.stringify(control)};
const LOG = ${JSON.stringify(log)};
let sessions = 0;
const held = [];
const write = value => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...value}) + "\\n");
const log = value => fs.appendFileSync(LOG, JSON.stringify(value) + "\\n");
const read = () => { try { return JSON.parse(fs.readFileSync(CONTROL,"utf8")); } catch { return {}; } };
const setup = id => ({sessionId:id,models:{availableModels:[{modelId:"fixture-model",name:"Fixture"}],currentModelId:"fixture-model"}});
const reply = message => {
  const resultId = message.method === "session/new" ? "s-" + (++sessions) : message.params.sessionId;
  write({id:message.id,result:message.method === "session/new" ? setup(resultId) : {}});
  log({event:"replied",id:message.id,method:message.method,resultId});
};
fs.watch(${JSON.stringify(directory)}, () => {
  if (!read().release) return;
  for (const message of held.splice(0)) { reply(message); log({event:"late",id:message.id,method:message.method}); }
});
readline.createInterface({input:process.stdin}).on("line",line=>{
  const message = JSON.parse(line);
  if (message.method === "$/cancel_request") { log({event:"cancel",requestId:message.params.requestId}); return; }
  if (!message.method || message.id === undefined) return;
  log({event:"request",id:message.id,method:message.method});
  if (message.method === "initialize") { write({id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true${method === "session/resume" ? ",sessionCapabilities:{resume:{}}" : ""}},authMethods:[]}}); return; }
  if (["session/new","session/load","session/resume"].includes(message.method)) {
    if (read().hold === message.method) {
      held.push(message);
      log({event:"held",id:message.id,method:message.method,server:message.params.mcpServers?.[0]});
      return;
    }
    reply(message); return;
  }
  if (message.method === "session/set_config_option") { write({id:message.id,result:{configOptions:[]}}); return; }
  write({id:message.id,result:{}});
});
`,
    { mode: 0o755 },
  );
  const saved: ProviderHistoryFragment[] = [
    {
      turnId: "saved-turn",
      status: "completed",
      items: [{ type: "agentMessage", id: "saved-message", text: "Saved task history." }],
      complete: true,
    },
  ];
  const original = structuredClone(saved);
  let appends = 0;
  const client = new AcpAgentClient({ executable, version: "1", source: "system" }, deadlineMs, {
    provider: "acp",
    label: "Synthetic ACP",
    flavor: DEFAULT_ACP_FLAVOR,
    argv: [],
    env: {},
    discoveryCwd: () => directory,
    signInMessage: "Fixture sign-in is unavailable.",
    history: {
      complete: () => Effect.succeed(true),
      read: (_request, consume) => Effect.forEach(saved, consume).pipe(Effect.asVoid),
      append: (_threadId, fragment) =>
        Effect.sync(() => {
          appends += 1;
          saved.push(fragment);
        }),
    },
  });
  client.start();
  try {
    await runCauseEffect(client.request("initialize", {}, () => undefined, deadlineMs));
    const healthy = await runCauseEffect(
      client.request("thread/start", { cwd: directory, dynamicTools: tools }, decodeThreadResponse),
    );
    await writeFile(control, JSON.stringify({ hold: method, release: false }));
    const open = () =>
      runCauseEffect(
        client.request(
          method === "session/new" ? "thread/start" : "thread/resume",
          { threadId: method === "session/new" ? undefined : "saved-session", cwd: directory, dynamicTools: tools },
          decodeThreadResponse,
        ),
      );
    const opening = open();
    // Capture each rejection now so a deadline cannot produce an unhandled Promise rejection.
    const outcome = opening.then(
      (value) => ({ kind: "opened" as const, value }),
      (error) => ({ kind: "failed" as const, error }),
    );
    const waiting =
      method === "session/new"
        ? null
        : open().then(
            (value) => ({ kind: "opened" as const, value }),
            (error) => ({ kind: "failed" as const, error }),
          );
    const held = await logEntry(directory, log, (entry) => entry.event === "held");
    const result = await Promise.race([
      outcome,
      new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), deadlineMs * 3)),
    ]);
    if (baseline) {
      assert.equal(result.kind, "pending", "The baseline should still wait beyond its configured start deadline.");
      report.observations.push({ method, pendingPastDeadline: true });
    } else {
      assert.equal(result.kind, "failed");
      if (result.kind !== "failed") throw new Error("The session setup did not fail safely.");
      assert.ok(result.error instanceof TimeoutError);
      assert.equal(isMissingProviderSessionError(result.error, "acp"), false);
      if (waiting) {
        const joined = await waiting;
        assert.equal(joined.kind, "failed");
        if (joined.kind === "failed") assert.equal(joined.error, result.error);
      }
      await logEntry(directory, log, (entry) => entry.event === "cancel" && entry.requestId === held.id);
      assert.ok(held.server);
      const bridge = await fetch(held.server.url, {
        method: "POST",
        headers: Object.fromEntries(held.server.headers.map((header) => [header.name, header.value])),
        body: "{}",
      });
      assert.equal(bridge.status, 401, "The timed-out session must lose its owned MCP route.");
    }
    await writeFile(control, JSON.stringify({ hold: method, release: true }));
    const late = await logEntry(directory, log, (entry) => entry.event === "late" && entry.id === held.id);
    assert.equal(late.method, method);
    await runCauseEffect(client.readSessionSettings(healthy.thread.id));
    if (baseline) {
      assert.equal((await outcome).kind, "opened");
      if (waiting) assert.equal((await waiting).kind, "opened");
    } else {
      const replies = await entries(log);
      const resultId = replies.find((entry) => entry.event === "replied" && entry.id === held.id)?.resultId;
      assert.ok(resultId);
      await assert.rejects(runCauseEffect(client.readSessionSettings(resultId)), /Unknown ACP session/);
      assert.equal(
        replies.filter((entry) => entry.event === "held").length,
        1,
        "Concurrent waiters must share one setup request.",
      );
      assert.equal(replies.filter((entry) => entry.event === "request" && entry.method === "session/prompt").length, 0);
      assert.deepEqual(saved, original);
      assert.equal(appends, 0);
      const history: ProviderHistoryFragment[] = [];
      await runCauseEffect(
        client.readHistory({ threadId: "saved-session", items: "full", cwd: directory }, (fragment) =>
          Effect.sync(() => {
            history.push(fragment);
            return true;
          }),
        ),
      );
      assert.deepEqual(history, original);
      report.observations.push({
        method,
        timedOut: true,
        cancelledOwnRequest: true,
        lateResponseIgnored: true,
        promptRequests: 0,
        heldRequests: 1,
        storedHistoryPreserved: true,
      });
    }
    report.cases.push(
      `${method}: ${baseline ? "silent setup waits past deadline and a late response is adopted" : "bounded shared setup cancels its request, ignores late success and preserves history without prompting"}.`,
    );
  } finally {
    await runCauseEffect(client.stop());
  }
}

try {
  for (const method of baseline
    ? (["session/load"] as const)
    : (["session/load", "session/resume", "session/new"] as const))
    await scenario(method);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, baseline ? "before.json" : "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
