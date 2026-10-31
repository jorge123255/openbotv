// Run: bun scripts/agent-context-catalog-e2e.ts
// Drives the real discovery, host policy, schema decoders and SQLite routine stores with fixtures.
// No app, provider, connector, real command or user profile starts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { z } from "zod";
import { routineToolPolicies } from "../src/backend/agent/routine-tools";
import {
  BUILTIN_TOOL_CATALOG,
  discoverTools,
  resolveDeferredTool,
  VISIBLE_DYNAMIC_TOOLS,
} from "../src/backend/agent/tool-catalog";
import { AgentRoutineStore } from "../src/backend/agent-routine-store";
import { ChannelRoutineStore } from "../src/backend/channel-routine-store";
import { ChannelStore } from "../src/backend/channel-store";
import { hostToolRequestFromCatalog } from "../src/backend/host-tools/host-tool-catalog";
import type { HostToolAction } from "../src/backend/host-tools/host-tool-policy";
import { HostToolPolicy } from "../src/backend/host-tools/host-tool-policy";
import { type HostToolRunnerDeps, runHostToolRequest } from "../src/backend/host-tools/host-tool-runner";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { OPENBOT_TOOL_DEFINITIONS } from "../src/backend/openbot-tools";
import type { DynamicToolCallParams } from "../src/backend/protocol";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/agent-context-catalog-e2e");
const fixtures: { tool: string; args: DynamicRecord; invalid: DynamicRecord; action?: HostToolAction }[] = [
  { tool: "host_shell", args: { command: "fixture command" }, invalid: { command: 7 }, action: "shell" },
  { tool: "host_screenshot", args: {}, invalid: { machineId: 7 }, action: "screenshot" },
  { tool: "host_read_file", args: { path: "fixture.txt" }, invalid: { path: 7 }, action: "read-file" },
  { tool: "host_list_directory", args: { path: "." }, invalid: { path: 7 }, action: "list-directory" },
  {
    tool: "host_write_file",
    args: { path: "fixture.txt", fileText: "fixture" },
    invalid: { path: "fixture.txt", fileText: 7 },
    action: "write-file",
  },
  { tool: "host_send_input", args: { chars: "fixture" }, invalid: { chars: 7 }, action: "send-input" },
  {
    tool: "host_mcp",
    args: { serverIdentifier: "fixture", toolName: "ping", arguments: { fixture: true } },
    invalid: { serverIdentifier: 7, toolName: "ping" },
    action: "mcp",
  },
  { tool: "host_list_machines", args: {}, invalid: { unexpected: true } },
];
const params = (tool: string, args: unknown): DynamicToolCallParams => ({
  namespace: "openbot",
  threadId: "fixture-thread",
  turnId: "fixture-turn",
  callId: "fixture-call",
  tool,
  arguments: args,
});
const checks: string[] = [];
const temporary = await mkdtemp(join(tmpdir(), "openbot-context-catalog-"));
const database = new OpenBotDatabase(join(temporary, "state"));
let passed = false;
let failure: string | undefined;
try {
  const search = VISIBLE_DYNAMIC_TOOLS.flatMap((namespace) => namespace.tools).find(
    (tool) => tool.name === "tool_search",
  );
  assert.ok(search);
  const expanded: string[] = [];
  for (const namespace of new Set(BUILTIN_TOOL_CATALOG.map((entry) => entry.namespace))) {
    const names = new RegExp(`${namespace}\\.\\{([^}]+)\\}`).exec(search.description)?.[1];
    assert.ok(names);
    expanded.push(...names.split(", ").map((name) => `${namespace}.${name}`));
  }
  assert.deepEqual(
    expanded,
    BUILTIN_TOOL_CATALOG.map((entry) => entry.name),
  );
  assert.equal(new Set(expanded).size, expanded.length);
  checks.push("Grouped catalog expands to every original qualified name, once and in order");

  for (const entry of BUILTIN_TOOL_CATALOG) {
    const found = discoverTools(params("tool_search", { query: entry.name, limit: 1 }));
    assert.equal(found.tools[0]?.name, entry.name);
    const described = discoverTools(params("tool_describe", { name: entry.name }));
    const tool = described.tools[0];
    assert.ok(tool && "inputSchema" in tool);
    assert.deepEqual(tool.inputSchema, entry.inputSchema);
    const resolved = resolveDeferredTool(params("tool_call", { name: entry.name, arguments: { fixture: true } }));
    assert.equal(resolved?.namespace, entry.namespace);
    assert.equal(resolved?.tool, entry.tool);
    assert.deepEqual(resolved?.arguments, { fixture: true });
  }
  assert.equal(resolveDeferredTool(params("tool_call", { name: "openbot.missing_fixture", arguments: {} })), null);
  assert.throws(() => discoverTools(params("tool_describe", { name: "openbot.missing_fixture" })));
  assert.equal(resolveDeferredTool(params("tool_call", { name: "openbot.host_shell", arguments: null })), null);
  checks.push("Every tool still searches, describes and resolves; unknown tools and malformed envelopes fail");

  for (const fixture of fixtures) {
    const qualified = `openbot.${fixture.tool}`;
    const found = discoverTools(params("tool_search", { query: fixture.tool, limit: 1 }));
    assert.equal(found.tools[0]?.name, qualified);
    const definition = OPENBOT_TOOL_DEFINITIONS.find((entry) => entry.name === fixture.tool);
    const advertised = BUILTIN_TOOL_CATALOG.find((entry) => entry.name === qualified);
    assert.ok(definition && advertised);
    const original = z.strictObject(definition.shape);
    const advertisedValidator = z.fromJSONSchema(advertised.inputSchema);
    for (const [input, accepted] of [
      [fixture.args, true],
      [fixture.invalid, false],
      [{ ...fixture.args, unexpected: true }, false],
      [null, false],
      [[], false],
    ] as const) {
      assert.equal(original.safeParse(input).success, accepted, qualified);
      assert.equal(advertisedValidator.safeParse(input).success, accepted, qualified);
    }
    const request = hostToolRequestFromCatalog(fixture.tool, fixture.args, {
      id: "fixture-call",
      agentId: "fixture-agent",
      threadId: "fixture-thread",
      turnId: "fixture-turn",
    });
    if (fixture.action) {
      assert.ok(request && typeof request !== "string");
      assert.equal(request.action, fixture.action);
    } else {
      assert.equal(typeof request, "string");
    }
  }
  for (const [query, expected] of [
    ["shell command registered machine", "openbot.host_shell"],
    ["screenshot registered machine", "openbot.host_screenshot"],
    ["read text file registered machine", "openbot.host_read_file"],
    ["MCP selected server", "openbot.host_mcp"],
  ]) {
    const found = discoverTools(params("tool_search", { query, limit: 10 }));
    assert.ok(found.tools.some((tool) => tool.name === expected));
  }
  checks.push(
    "All eight host tools keep discovery, advertised/original validation and dispatch; host keyword queries work",
  );

  let executions = 0;
  let asks = 0;
  const computer = { id: "fixture-machine", label: "Fixture", connected: true };
  const deps: HostToolRunnerDeps = {
    policy: new HostToolPolicy(),
    computer,
    execute: {
      root: temporary,
      computer,
      run: async () => {
        executions += 1;
        return { code: 0, stdout: "fixture", stderr: "" };
      },
      capture: async () => ({ denied: true }),
      writeShot: async () => ({ path: "", thumbnailPath: "" }),
    },
    now: () => Date.now(),
    ask: async () => {
      asks += 1;
      return asks === 1 ? "allow-once" : "expired";
    },
    emitRow: () => {},
  };
  const request = hostToolRequestFromCatalog(
    "host_shell",
    { command: "fixture command" },
    {
      id: "fixture-policy",
      agentId: "fixture-agent",
      threadId: "fixture-thread",
      turnId: "fixture-turn",
    },
  );
  assert.ok(request && typeof request !== "string");
  assert.equal((await runHostToolRequest(request, deps)).status, "completed");
  assert.equal((await runHostToolRequest(request, deps)).status, "failed");
  assert.equal(executions, 1);
  assert.equal(asks, 2);
  deps.policy.denyForever("shell");
  assert.equal((await runHostToolRequest(request, deps)).status, "failed");
  assert.equal(executions, 1);
  assert.equal(asks, 2);
  checks.push("Host allow-once does not persist; expired and saved denial cannot execute a command");

  for (const name of ["create_routine", "update_routine", "channel_create_routine", "channel_update_routine"]) {
    const definition = OPENBOT_TOOL_DEFINITIONS.find((entry) => entry.name === name);
    assert.ok(definition);
    const schema = z.strictObject(definition.shape);
    const input = name.includes("update")
      ? { routineId: "fixture-routine", name: "Fixture" }
      : { name: "Fixture", instruction: "Check fixture records.", schedule: { kind: "daily", time: "09:00" } };
    assert.equal(schema.safeParse(input).success, true, name);
    assert.equal(schema.safeParse({ ...input, limitPolicy: "invalid" }).success, false, name);
    assert.equal(schema.safeParse({ ...input, missedPolicy: "invalid" }).success, false, name);
  }
  assert.deepEqual(routineToolPolicies({}), {});
  assert.throws(() => routineToolPolicies({ limitPolicy: "invalid" }));
  checks.push("Routine tools still allow omitted policies and reject invalid policy values");

  await Effect.runPromise(database.initialize());
  const agents = new AgentRoutineStore(database);
  const channels = new ChannelRoutineStore(database);
  const channelStore = new ChannelStore(database);
  channelStore.commit("fixture-channel-created", {
    channel: channelStore.create("fixture-channel", {
      name: "Fixture",
      title: "Fixture",
      instructions: "Check fixture records.",
      members: [],
      leadAgentId: null,
    }),
    messages: [],
    tasks: [],
    assignments: [],
  });
  const now = new Date("2035-01-01T00:00:00.000Z");
  const base = { name: "Fixture", instruction: "Check fixture records.", active: false, timezone: "UTC" };
  const daily = { kind: "daily", time: "09:00" } as const;
  const once = { kind: "once", date: "2035-01-02", time: "09:00" } as const;
  const agent = agents.create({ ...base, agentId: "fixture-agent", schedule: daily }, now);
  const channel = channels.create({ ...base, channelId: "fixture-channel", schedule: daily }, now);
  for (const routine of [agent, channel]) {
    assert.equal(routine.limitPolicy, "wait");
    assert.equal(routine.missedPolicy, "skip");
  }
  const agentOnce = agents.create({ ...base, agentId: "fixture-agent", schedule: once, limitPolicy: "skip" }, now);
  const channelOnce = channels.create({ ...base, channelId: "fixture-channel", schedule: once }, now);
  for (const routine of [agentOnce, channelOnce]) {
    assert.equal(routine.limitPolicy, "wait");
    assert.equal(routine.missedPolicy, "run-once");
  }
  agents.update({ agentId: agent.agentId, routineId: agent.id, limitPolicy: "skip", missedPolicy: "run-once" }, now);
  channels.update(
    { channelId: channel.channelId, routineId: channel.id, limitPolicy: "skip", missedPolicy: "run-once" },
    now,
  );
  const updatedAgent = agents.update({ agentId: agent.agentId, routineId: agent.id, name: "Renamed" }, now);
  const updatedChannel = channels.update({ channelId: channel.channelId, routineId: channel.id, name: "Renamed" }, now);
  for (const routine of [updatedAgent, updatedChannel]) {
    assert.equal(routine.limitPolicy, "skip");
    assert.equal(routine.missedPolicy, "run-once");
  }
  database.close();
  await Effect.runPromise(database.initialize());
  assert.equal(agents.get(agent.agentId, agent.id)?.missedPolicy, "run-once");
  assert.equal(channels.get(channel.channelId, channel.id)?.limitPolicy, "skip");
  checks.push("Real agent/channel SQLite stores preserve recurring/once defaults, update omissions and restart state");
  passed = true;
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
} finally {
  database.close();
  await rm(temporary, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const path of [
    "src/backend/openbot-tools.ts",
    "src/backend/routine-tool-schema.ts",
    "src/backend/agent/tool-catalog.ts",
    "scripts/agent-context-catalog-e2e.ts",
  ]) {
    hashes[path] = createHash("sha256")
      .update(await readFile(join(ROOT, path)))
      .digest("hex");
  }
  await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, checks, hashes, failure }, null, 2)}\n`);
  process.stdout.write(`${passed ? "passed" : "FAILED"}: ${checks.length} groups; ${OUT}/report.json\n`);
  if (failure) process.stderr.write(`${failure}\n`);
  process.exitCode = passed ? 0 : 1;
}
