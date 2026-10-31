// Host MCP stays on this computer and uses only the agent's selected servers.
// bun scripts/host-tool-mcp-e2e.ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { mcpSuccessMessage, runHostMcp } from "../src/backend/host-tools/host-mcp";
import { hostRequestFromExec } from "../src/backend/host-tools/local-exec-frames";

const checks: string[] = [];

function server(id: string): McpServerConfig {
  return {
    id,
    name: id,
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "http://127.0.0.1",
    headers: [],
  };
}

function forAgent(selections: Readonly<Record<string, readonly string[] | undefined>>) {
  return (configs: readonly McpServerConfig[], agentId: string): McpServerConfig[] => {
    if (!(agentId in selections)) return [];
    const ids = selections[agentId];
    if (ids === undefined) return [...configs];
    const selected = new Set(ids);
    return configs.filter((config) => selected.has(config.id));
  };
}

const configs = [server("srv")];
let calls = 0;
const call = async () => {
  calls += 1;
  return "pong";
};

const selected = await runHostMcp({
  configs,
  agentId: "a",
  forAgent: forAgent({ a: ["srv"] }),
  serverIdentifier: "srv",
  toolName: "ping",
  call,
});
assert.deepEqual(selected, { text: "pong" });
assert.equal(calls, 1);
checks.push("selected");

const beforeEmpty = calls;
const empty = await runHostMcp({
  configs,
  agentId: "a",
  forAgent: forAgent({ a: [] }),
  serverIdentifier: "srv",
  toolName: "ping",
  call,
});
assert.deepEqual(empty, { refused: true });
assert.equal(calls, beforeEmpty);
checks.push("empty");

const beforeOther = calls;
const other = await runHostMcp({
  configs,
  agentId: "b",
  forAgent: forAgent({ a: ["srv"] }),
  serverIdentifier: "srv",
  toolName: "ping",
  call,
});
assert.deepEqual(other, { refused: true });
assert.equal(calls, beforeOther);
checks.push("other-agent");

const mapped = hostRequestFromExec("m1", {
  message: { case: "mcpArgs", value: { serverIdentifier: "srv", toolName: "ping" } },
});
assert.ok(mapped);
assert.equal(mapped.action, "mcp");
const fromFrame = await runHostMcp({
  configs,
  agentId: "a",
  forAgent: forAgent({ a: ["srv"] }),
  ...(mapped.serverIdentifier === undefined ? {} : { serverIdentifier: mapped.serverIdentifier }),
  toolName: mapped.toolName ?? "",
  call,
});
assert.deepEqual(fromFrame, { text: "pong" });
assert.deepEqual(mcpSuccessMessage("pong"), {
  mcpResult: { success: { content: [{ text: { text: "pong" } }], isError: false } },
});
checks.push("mcp-args");

await mkdir(".openbot-build", { recursive: true });
await writeFile(".openbot-build/host-tool-mcp-e2e.json", JSON.stringify({ ok: true, checks }, null, 2));
