// Drives the real SQLite stores, MCP gateway and ACP provider with temporary profiles and a fake
// executable. No installed app, user profile, provider account or external MCP server is used.
// bun scripts/agent-mcp-scope-e2e.ts. Writes .openbot-build/agent-mcp-scope-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMPUTER_USE_MCP_SERVER_ID, type McpServerConfig } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { McpGateway } from "../src/backend/agent/mcp-gateway";
import type { AgentClient } from "../src/backend/agent-client";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { McpServerStore } from "../src/backend/mcp-server-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { decodeRecordResponse, getRecord, getString } from "../src/backend/protocol";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { CustomAgentStore } from "../src/main/custom-agent-store";
import { parseUpdateAgent } from "../src/main/ipc/agent-inputs";
import { installFakeAgent, readJsonl, stopClients, xorCipher } from "./provider-fakes/host";

const out = resolve(import.meta.dirname, "../.openbot-build/agent-mcp-scope-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-mcp-scope-"));
const database = new OpenBotDatabase(join(root, "state"));
const store = new AgentStore(database.userDataPath, join(root, "home"), database);
const clients: AgentClient[] = [];
const checks: string[] = [];
const report: { passed: boolean; checks: string[]; error?: string } = { passed: false, checks };
let gateway: McpGateway | undefined;

function server(name: string): McpServerConfig {
  return {
    id: "",
    name,
    transport: "stdio",
    enabled: true,
    command: process.execPath,
    args: ["-e", "process.stdin.resume()"],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "",
    headers: [],
  };
}

try {
  await runCauseEffect(store.initialize());
  const create = (name: string) =>
    runCauseEffect(store.createAgent({ name, description: "", avatarSeed: name, avatarHue: null }));
  const first = await create("first");
  const second = await create("second");
  const servers = new McpServerStore(database);
  const docs = servers.save(server("docs"));
  const calendar = servers.save(server("calendar"));
  servers.save({ ...server("disabled"), enabled: false });
  const computer = { ...server("computer_use"), id: COMPUTER_USE_MCP_SERVER_ID };
  gateway = new McpGateway({
    servers,
    credentials: NO_PROVIDER_CREDENTIALS,
    computerUseMcpServer: () => computer,
    agents: () => store.list(),
    logger: createOpenBotLogger("scope-e2e", () => undefined),
    hooks: { emitError: () => undefined, refreshAllAgentRuntimes: () => Effect.void },
  });
  const activeGateway = gateway;
  const names = (id: string) => activeGateway.forAgent(activeGateway.enabled(), id).map((row) => row.name);
  assert.deepEqual(names(first.id), ["docs", "calendar", "computer_use"]);
  assert.deepEqual(names(second.id), names(first.id));
  checks.push("Existing and new agents keep all enabled servers by default; disabled servers stay absent.");
  for (const value of ["docs", [null], [""], Array.from({ length: 10000 }, () => docs.id)])
    assert.throws(() => parseUpdateAgent({ agentId: first.id, mcpServerIds: value }));
  await runCauseEffect(store.updateAgent(parseUpdateAgent({ agentId: first.id, mcpServerIds: [docs.id, docs.id] })));
  assert.deepEqual(store.list().find((row) => row.id === first.id)?.mcpServerIds, [docs.id]);
  assert.deepEqual(names(first.id), ["docs", "computer_use"]);
  assert.deepEqual(names(second.id), ["docs", "calendar", "computer_use"]);
  assert.deepEqual(names("missing-owner"), []);
  assert.ok("error" in (await runCauseEffect(activeGateway.endpoint(calendar, first.id))));
  checks.push(
    "Selection is validated and deduplicated; another agent is unchanged; unknown owners and excluded endpoints fail closed.",
  );
  const duplicate = await runCauseEffect(store.duplicateAgent(first.id));
  assert.deepEqual(duplicate.mcpServerIds, [docs.id]);
  const reloaded = new AgentStore(database.userDataPath, join(root, "home"), database);
  await runCauseEffect(reloaded.initialize());
  assert.deepEqual(reloaded.list().find((row) => row.id === first.id)?.mcpServerIds, [docs.id]);
  checks.push("Selection survives restart and duplication.");

  const executable = join(root, "bin", "fake-acp");
  const log = join(root, "requests.jsonl");
  await installFakeAgent(executable, "mcp-names");
  const custom = new CustomAgentStore({ path: join(root, "custom.json"), cipher: xorCipher });
  await runCauseEffect(custom.load());
  await runCauseEffect(
    custom.save({
      id: "scope",
      name: "scope",
      command: executable,
      args: [],
      env: [{ name: "FAKE_LOG", value: log }],
      usagePrompt: null,
    }),
  );
  const driver = requireProviderDriver("acp");
  const sourceOwners: Array<string | null | undefined> = [];
  const client = driver.createClient(await runCauseEffect(driver.resolveCli()), 20_000, {
    ...NO_PROVIDER_CREDENTIALS,
    customAgents: () => custom.configs(),
    mcpServers: (id) => {
      sourceOwners.push(id);
      return activeGateway.forAgent(activeGateway.enabled(), id);
    },
  });
  clients.push(client);
  client.start();
  const open = async (id: string) => {
    const cwd = join(root, id);
    await mkdir(cwd, { recursive: true });
    await runCauseEffect(
      client.request("thread/start", { cwd, model: "scope/default", openbotAgentId: id }, (value) => value),
    );
    const requests = await readJsonl<{ names: string[] }>(log);
    return requests.at(-1)?.names.filter((name) => ["docs", "calendar", "computer_use", "disabled"].includes(name));
  };
  assert.deepEqual(await open(first.id), ["docs", "computer_use"]);
  assert.deepEqual(await open(second.id), ["docs", "calendar", "computer_use"]);
  await runCauseEffect(store.updateAgent({ agentId: first.id, mcpServerIds: [] }));
  assert.deepEqual(await open(first.id), ["computer_use"]);
  await runCauseEffect(store.updateAgent({ agentId: first.id, mcpServerIds: null }));
  assert.deepEqual(await open(first.id), ["docs", "calendar", "computer_use"]);
  assert.deepEqual(sourceOwners, [first.id, second.id, first.id, first.id]);
  checks.push(
    "Real ACP session requests get selected, independent, empty and restored sets; built-in Computer Use stays separate.",
  );
  await runCauseEffect(store.updateAgent({ agentId: first.id, mcpServerIds: [docs.id] }));
  const coldSetup = { cwd: join(root, first.id), model: "scope/default" };
  const coldResponse = await runCauseEffect(client.request("thread/start", coldSetup, decodeRecordResponse));
  const coldId = getString(getRecord(coldResponse, "thread"), "id");
  assert.ok(coldId);
  const coldParams = { ...coldSetup, threadId: coldId };
  const coldRequests = await readJsonl<{ names: string[] }>(log);
  assert.deepEqual(coldRequests.at(-1)?.names, [], "An ownerless history session receives no external servers.");
  await runCauseEffect(client.request("thread/resume", { ...coldParams, openbotAgentId: first.id }, (value) => value));
  const ownedRequests = await readJsonl<{ names: string[] }>(log);
  assert.deepEqual(ownedRequests.at(-1)?.names, ["docs", "computer_use"]);
  checks.push("A session loaded without an owner gets no servers and reloads the selected set before an owned turn.");

  // Corrupt only the temporary projection, then read it through the normal store recovery path.
  database.connection
    .prepare(
      "UPDATE projection_agents SET agent_json = json_set(agent_json, '$.mcpServerIds', 'bad') WHERE agent_id = ?",
    )
    .run(first.id);
  const repaired = new AgentStore(database.userDataPath, join(root, "home"), database);
  await runCauseEffect(repaired.initialize());
  assert.deepEqual(repaired.list().find((row) => row.id === first.id)?.mcpServerIds, []);
  checks.push("An unreadable stored scope repairs to no external servers, never all servers.");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await stopClients(clients);
  if (gateway) await runCauseEffect(gateway.close());
  database.close();
  await rm(root, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
