// Host MCP stays on this computer and uses only the agent's selected servers.
// bun scripts/host-tool-mcp-e2e.ts
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { callHostMcpTool, mcpSuccessMessage, runHostMcp } from "../src/backend/host-tools/host-mcp";
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

// Drive the real SDK transport and host call against an owned loopback MCP endpoint.
const requests: string[] = [];
const fixtureErrors: Error[] = [];
const fixtureSession = "synthetic-host-mcp-session";
const authorization = "synthetic-host-mcp-bearer";
const http = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, `Bearer ${authorization}`);
    if (request.method === "GET") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    assert.equal(request.method, "POST");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    assert.ok("method" in message);
    requests.push(message.method);
    if (message.method !== "initialize") assert.equal(request.headers["mcp-session-id"], fixtureSession);
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    assert.ok("id" in message);
    response.setHeader("content-type", "application/json");
    if (message.method === "initialize") {
      assert.equal(request.headers["mcp-session-id"], undefined);
      const initialize = InitializeRequestSchema.parse(message);
      assert.equal(initialize.params.clientInfo.name, "openbot-host-tool");
      response.setHeader("mcp-session-id", fixtureSession);
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: initialize.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "host-mcp-fixture", version: "1" },
          },
        }),
      );
      return;
    }
    const call = CallToolRequestSchema.parse(message);
    assert.equal(call.params.name, "ping");
    assert.deepEqual(call.params.arguments, { fixture: "ping" });
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } }),
    );
  } catch (error) {
    fixtureErrors.push(error instanceof Error ? error : new Error("The synthetic MCP request failed."));
    response.writeHead(500, { "content-type": "application/json" }).end("{}");
  }
});
http.listen(0, "127.0.0.1");
await once(http, "listening");
try {
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = { url: `http://127.0.0.1:${address.port}/mcp`, authorization };
  const actual = await runHostMcp({
    configs,
    agentId: "a",
    forAgent: forAgent({ a: ["srv"] }),
    serverIdentifier: "srv",
    toolName: "ping",
    arguments: { fixture: "ping" },
    call: (config, toolName, args) => callHostMcpTool({ config, endpoint, toolName, arguments: args }),
  });
  assert.deepEqual(actual, { text: "pong" });
  assert.deepEqual(fixtureErrors, []);
  assert.deepEqual(requests, ["initialize", "notifications/initialized", "tools/call"]);
  checks.push("real-http-session-and-host-call");
} finally {
  await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
}

await mkdir(".openbot-build", { recursive: true });
await writeFile(".openbot-build/host-tool-mcp-e2e.json", JSON.stringify({ ok: true, checks }, null, 2));
