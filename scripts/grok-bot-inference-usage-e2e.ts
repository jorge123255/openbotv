// Reads raw provider counters through a real loopback HTTP service. No live account is used.
// bun scripts/grok-bot-inference-usage-e2e.ts
// Writes .openbot-build/grok-bot-inference-usage-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { GrokBotAccountStore } from "../src/backend/grok-bot/grok-bot-account";
import { GrokBotAgentClient } from "../src/backend/grok-bot/grok-bot-agent-client";
import {
  type GrokBotInferenceUsage,
  grokBotStreamBody,
  readGrokBotInference,
} from "../src/backend/grok-bot/grok-bot-inference";
import { decodeThreadResponse, decodeTurnResponse, getString } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/grok-bot-inference-usage-e2e");
const report: { passed: boolean; cases: string[] } = { passed: false, cases: [] };
const emptyCounts = {
  prompt: null,
  completion: null,
  total: null,
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
};
let frames: Buffer[] = [];
let holdOpen = false;
let status = 200;
let sent = false;
let sendBody = "";
let inferenceCalls = 0;
function frame(value: unknown, flags = 0): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}
const eventStreams = new Set<ServerResponse>();
let pendingGatewayEnd = "";
function publishGatewayEnd(): void {
  pendingGatewayEnd = `data: ${JSON.stringify({
    channel: "transcript",
    payload: { agentId: "gateway-agent", type: "turn-ended" },
  })}\n\n`;
  for (const stream of eventStreams) {
    if (!stream.writableEnded) stream.write(pendingGatewayEnd);
  }
}
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    if (request.url === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      eventStreams.add(response);
      response.write(":ping\n\n");
      if (pendingGatewayEnd.length > 0) response.write(pendingGatewayEnd);
      response.on("close", () => eventStreams.delete(response));
      return;
    }
    if (request.url === "/aiserver.v1.InferenceService/Stream") {
      inferenceCalls += 1;
      response.writeHead(status, { "content-type": "application/connect+json" });
      response.write(Buffer.concat(frames));
      if (!holdOpen) response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/createAgent") response.end(JSON.stringify({ agent: { id: "gateway-agent" } }));
    else if (request.url === "/api/sendPrompt") {
      sendBody = Buffer.concat(chunks).toString("utf8");
      sent = true;
      response.end('{"accepted":true}');
      publishGatewayEnd();
    } else if (request.url === "/api/getAgentTranscriptTail") {
      response.end(
        JSON.stringify({
          entries: sent
            ? [
                { role: "user", text: "Gateway prompt" },
                { role: "assistant", text: "Gateway reply" },
              ]
            : [],
        }),
      );
    } else response.end("{}");
  });
});
await new Promise<void>((ready, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", ready);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const apiBaseUrl = `http://127.0.0.1:${address.port}`;

async function readCase(
  name: string,
  body: Buffer[],
  expected: GrokBotInferenceUsage | null,
  failure = false,
  interrupt = false,
) {
  frames = body;
  holdOpen = interrupt;
  const controller = new AbortController();
  const reports: GrokBotInferenceUsage[] = [];
  let failed = false;
  try {
    await readGrokBotInference({
      apiBaseUrl,
      accessToken: "synthetic-access-e2e",
      machineId: "synthetic-machine",
      signal: controller.signal,
      body: grokBotStreamBody({
        messages: [{ role: "USER", text: "Synthetic prompt" }],
        modelId: "default",
        conversationId: "synthetic-thread",
        invocationId: name,
      }),
      onUsage: (usage) => reports.push(usage),
      onEvent: () => {
        if (interrupt) controller.abort();
      },
    });
  } catch {
    failed = true;
  }
  assert.equal(failed, failure, name);
  assert.deepEqual(reports, expected ? [expected] : [], name);
  report.cases.push(name);
}
try {
  const basic = frame({ usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, ignored: "do-not-copy" } });
  const extended = frame({
    extendedUsage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 2 },
  });
  const counters = { prompt: 20, completion: 3, total: 23, input: 20, output: 3, cacheRead: 8, cacheWrite: 2 };
  await readCase("duplicate-basic-and-extended", [basic, extended, basic, extended, frame({}, 2)], counters);
  await readCase("extended-before-basic", [extended, basic, frame({}, 2)], counters);
  await readCase(
    "missing-total-is-unknown",
    [frame({ usage: { promptTokens: 20, completionTokens: 3 } }), frame({}, 2)],
    { ...emptyCounts, prompt: 20, completion: 3 },
  );
  await readCase(
    "explicit-zero",
    [frame({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }), frame({}, 2)],
    { ...emptyCounts, prompt: 0, completion: 0, total: 0 },
  );
  await readCase("missing-counters", [frame({ textPart: { text: "Done" } }), frame({}, 2)], null);
  const invalid = frame({
    usage: { promptTokens: -1, completionTokens: 1.5, totalTokens: "10" },
    extendedUsage: {
      inputTokens: Number.MAX_SAFE_INTEGER + 1,
      outputTokens: null,
      cacheReadTokens: -4,
      cacheWriteTokens: false,
    },
  });
  await readCase("invalid-counters", [invalid, frame({}, 2)], null);
  await readCase("invalid-does-not-erase-valid", [basic, invalid, frame({}, 2)], {
    ...emptyCounts,
    prompt: 20,
    completion: 3,
    total: 23,
  });
  await readCase(
    "usage-before-error-trailer-in-same-chunk",
    [basic, frame({ error: { code: "internal", message: "Synthetic failure" } }, 2)],
    { ...emptyCounts, prompt: 20, completion: 3, total: 23 },
    true,
  );
  await readCase(
    "usage-before-interrupt",
    [basic, frame({ textPart: { text: "Interrupt now" } })],
    { ...emptyCounts, prompt: 20, completion: 3, total: 23 },
    true,
    true,
  );
  status = 401;
  await readCase("http-failure-has-no-counters", [], null, true);
  status = 200;

  const root = await mkdtemp(join(tmpdir(), "openbot-grok-usage-"));
  const store = new GrokBotAccountStore(join(root, "account.json"), {
    encrypt: (value: string) => Buffer.from(value),
    decrypt: (value: Buffer) => value.toString("utf8"),
  });
  await Effect.runPromise(
    store.save({
      accessToken: "synthetic-access-e2e",
      refreshToken: "synthetic-refresh-e2e",
      gateway: { url: apiBaseUrl, token: "synthetic-gateway-e2e", headers: {} },
    }),
  );
  const client = new GrokBotAgentClient({ store, apiBaseUrl, allowLoopback: true, gatewayPollMs: 1 });
  const diagnostics: string[] = [];
  client.on("diagnostic", (line) => diagnostics.push(line));
  client.start();
  try {
    const { thread } = await Effect.runPromise(
      client.request(
        "thread/start",
        { developerInstructions: "Keep this full history instruction." },
        decodeThreadResponse,
      ),
    );
    const callsBefore = inferenceCalls;
    let gatewayReply = "";
    const completed = new Promise<void>((ready, reject) => {
      const deadline = setTimeout(() => reject(new Error("Gateway did not complete")), 2000);
      client.on("notification", (note) => {
        if (note.method === "item/agentMessage/delta") gatewayReply += getString(note.params, "delta") ?? "";
        if (note.method !== "turn/completed") return;
        clearTimeout(deadline);
        try {
          assert.equal(decodeTurnResponse(note.params).turn.status, "completed");
          ready();
        } catch (error) {
          reject(error);
        }
      });
    });
    await Effect.runPromise(
      client.request(
        "turn/start",
        { threadId: thread.id, input: [{ type: "text", text: "Gateway prompt" }] },
        decodeTurnResponse,
      ),
    );
    await completed;
    assert.equal(gatewayReply, "Gateway reply");
    assert.equal(inferenceCalls, callsBefore);
    assert.equal(
      diagnostics.some((line) => line.startsWith("Grok Bot direct inference token counts: ")),
      false,
    );
    const posted = JSON.parse(sendBody);
    assert.equal(posted.prompt, "Gateway prompt");
    assert.equal(posted.messages, undefined);
    assert.equal(posted.agentId, thread.id);
    assert.equal(typeof posted.clientNonce, "string");
    report.cases.push("default-gateway-has-no-invented-counters");
  } finally {
    await Effect.runPromise(client.stop());
  }
  report.passed = true;
} finally {
  for (const stream of eventStreams) stream.end();
  await new Promise<void>((ready, reject) => server.close((error) => (error ? reject(error) : ready())));
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
