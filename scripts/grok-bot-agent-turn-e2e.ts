// Creates a Grok Bot sand agent and streams one turn through InferenceService.
// The local server stands in for api2.cursor.sh and the sand gateway. No account is used.
// bun scripts/grok-bot-agent-turn-e2e.ts
// Writes .openbot-build/grok-bot-agent-turn-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { GrokBotAccountStore } from "../src/backend/grok-bot/grok-bot-account";
import { GrokBotAgentClient } from "../src/backend/grok-bot/grok-bot-agent-client";
import { GROK_BOT_RUNTIME } from "../src/backend/grok-bot/grok-bot-runtime";
import { decodeAccountReadResult, decodeThreadResponse, decodeTurnResponse } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/grok-bot-agent-turn-e2e");
const ACCESS = "grok-access-e2e";
const REFRESH = "grok-refresh-e2e";
const cipher = {
  encrypt: (value: string) => Buffer.from(value, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8"),
};

const report = {
  passed: false,
  remoteRuntime: false,
  createdOnce: false,
  streamed: false,
  resumed: false,
  usage: false,
  signedOut: false,
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((ready, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => ready(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function connectFrame(value: unknown, flags = 0): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const root = await mkdtemp(join(tmpdir(), "openbot-grok-bot-turn-"));
const authFile = join(root, "grok-account.json");
let createCalls = 0;
const streamBodies: string[] = [];
const streamAuth: string[] = [];

const server = createServer((request, response: ServerResponse) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    if (url.pathname === "/aiserver.v1.GrokBotService/EnsureSandBox") {
      assert.equal(request.headers.authorization, `Bearer ${ACCESS}`);
      assert.equal(request.headers["x-cursor-client-type"], "sand");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          gatewayUrl: `http://127.0.0.1:${addressPort}`,
          gatewayToken: "gw-e2e",
          anyrunNetworkToken: "net-e2e",
        }),
      );
      return;
    }
    if (url.pathname === "/api/createAgent") {
      createCalls += 1;
      assert.equal(request.headers.authorization, "Bearer gw-e2e");
      const parsed = JSON.parse(body);
      assert.equal(isDynamicRecord(parsed) && parsed.origin, "user");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agent: { id: "sand-agent-e2e", name: "OpenBot" } }));
      return;
    }
    if (url.pathname === "/api/listAgents") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agents: [{ id: "sand-agent-e2e", name: "OpenBot" }] }));
      return;
    }
    if (url.pathname === "/aiserver.v1.InferenceService/Stream") {
      streamAuth.push(request.headers.authorization ?? "");
      streamBodies.push(body);
      assert.equal(request.headers.authorization, `Bearer ${ACCESS}`);
      assert.equal(request.headers["connect-protocol-version"], "1");
      assert.equal(request.headers["x-cursor-client-type"], "sand");
      response.writeHead(200, { "content-type": "application/connect+json" });
      response.end(
        Buffer.concat([
          connectFrame({ textPart: { text: "Hello", isFinal: false } }),
          connectFrame({ textPart: { text: " from Grok Bot", isFinal: false } }),
          connectFrame({ textPart: { text: "", isFinal: true } }),
          connectFrame({ usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 } }),
          connectFrame({}, 0x02),
        ]),
      );
      return;
    }
    if (url.pathname === "/aiserver.v1.DashboardService/GetSandUsageStatus") {
      assert.equal(request.headers.authorization, `Bearer ${ACCESS}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sandUsagePercent: 41, hasAvailableUsage: true }));
      return;
    }
    if (url.pathname.startsWith("/aiserver.v1.DashboardService/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(404).end();
  })().catch((error: unknown) => {
    response.writeHead(500).end(error instanceof Error ? error.message : "failed");
  });
});

await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
const bound = server.address();
assert.ok(bound !== null && typeof bound === "object");
const addressPort = bound.port;
const apiBaseUrl = `http://127.0.0.1:${addressPort}`;

function clientFor(store: GrokBotAccountStore): GrokBotAgentClient {
  return new GrokBotAgentClient({
    store,
    apiBaseUrl,
    allowLoopback: true,
    requestTimeoutMs: 5_000,
  });
}

try {
  report.remoteRuntime =
    GROK_BOT_RUNTIME.remote === true && GROK_BOT_RUNTIME.executable === "" && GROK_BOT_RUNTIME.version === "remote";
  assert.equal(report.remoteRuntime, true);

  const empty = new GrokBotAccountStore(join(root, "empty.json"), cipher);
  const signedOut = clientFor(empty);
  signedOut.start();
  const missing = await Effect.runPromise(signedOut.request("account/read", {}, decodeAccountReadResult));
  report.signedOut = missing.account === null;
  assert.equal(report.signedOut, true);
  await Effect.runPromise(signedOut.stop());

  const store = new GrokBotAccountStore(authFile, cipher);
  await Effect.runPromise(store.save({ accessToken: ACCESS, refreshToken: REFRESH, gateway: null }));
  const client = clientFor(store);
  const notes: Array<{ method: string; params: unknown }> = [];
  client.on("notification", (notification) => notes.push(notification));
  client.start();
  const account = await Effect.runPromise(client.request("account/read", {}, decodeAccountReadResult));
  assert.equal(account.account?.type, "grok-bot");
  const models = await Effect.runPromise(client.request("model/list", {}, (value) => value));
  assert.equal(isDynamicRecord(models) && Array.isArray(models.data) && models.data[0]?.model, "default");
  const started = await Effect.runPromise(
    client.request(
      "thread/start",
      { openbotAgentId: "local-agent", developerInstructions: "Be brief." },
      decodeThreadResponse,
    ),
  );
  assert.equal(started.thread.id, "sand-agent-e2e");
  const turn = await Effect.runPromise(
    client.request(
      "turn/start",
      {
        threadId: started.thread.id,
        model: "default",
        input: [{ type: "text", text: "Hello" }],
      },
      decodeTurnResponse,
    ),
  );
  assert.equal(turn.turn.status, "inProgress");
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("turn did not finish")), 2_000);
    const done = () => {
      if (!notes.some((note) => note.method === "turn/completed")) return;
      clearTimeout(timer);
      client.off("notification", done);
      ready();
    };
    client.on("notification", done);
    done();
  });
  const text = notes
    .filter((note) => note.method === "item/agentMessage/delta")
    .map((note) => (isDynamicRecord(note.params) && typeof note.params.delta === "string" ? note.params.delta : ""))
    .join("");
  report.streamed = text === "Hello from Grok Bot";
  assert.equal(report.streamed, true);
  const first = JSON.parse(streamBodies[0] ?? "{}");
  assert.equal(isDynamicRecord(first) && first.conversationId, "sand-agent-e2e");
  assert.equal(
    isDynamicRecord(first) && isDynamicRecord(first.requestedModel) && first.requestedModel.modelId,
    "default",
  );
  const firstMessages = isDynamicRecord(first) && Array.isArray(first.messages) ? first.messages : [];
  assert.equal(
    firstMessages.some((message) => isDynamicRecord(message) && message.role === "USER" && message.text === "Hello"),
    true,
  );
  assert.equal(streamAuth[0], `Bearer ${ACCESS}`);
  assert.equal(streamAuth[0]?.includes("gw-e2e"), false);

  const again = clientFor(store);
  again.start();
  await Effect.runPromise(again.request("thread/resume", { threadId: "sand-agent-e2e" }, decodeThreadResponse));
  const secondPosted = new Promise<string>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("the resumed turn did not reach InferenceService")), 2_000);
    const previous = streamBodies.length;
    const timerId = setInterval(() => {
      const body = streamBodies[previous];
      if (body === undefined) return;
      clearInterval(timerId);
      clearTimeout(timer);
      ready(body);
    }, 5);
  });
  await Effect.runPromise(
    again.request(
      "turn/start",
      { threadId: "sand-agent-e2e", model: "default", input: [{ type: "text", text: "Again" }] },
      decodeTurnResponse,
    ),
  );
  const second = JSON.parse(await secondPosted);
  report.resumed = isDynamicRecord(second) && second.conversationId === "sand-agent-e2e" && createCalls === 1;
  assert.equal(report.resumed, true);
  report.createdOnce = createCalls === 1;

  const limits = await Effect.runPromise(again.request("account/rateLimits/read", {}, (value) => value));
  const primary = isDynamicRecord(limits) && isDynamicRecord(limits.rateLimits) ? limits.rateLimits.primary : undefined;
  report.usage = isDynamicRecord(primary) && primary.usedPercent === 41;
  assert.equal(report.usage, true);
  await Effect.runPromise(client.stop());
  await Effect.runPromise(again.stop());
  report.passed = true;
} finally {
  await new Promise<void>((ready, reject) => server.close((error) => (error ? reject(error) : ready())));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exit(1);
