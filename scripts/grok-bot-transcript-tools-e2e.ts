// A Grok Bot gateway turn shows sand tool rows from the transcript.
// The local server stands in for api2.cursor.sh and the sand gateway. No account is used.
// OpenBot does not call item/tool/call.
// bun scripts/grok-bot-transcript-tools-e2e.ts
// Writes .openbot-build/grok-bot-transcript-tools-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { GrokBotAccountStore } from "../src/backend/grok-bot/grok-bot-account";
import { GrokBotAgentClient } from "../src/backend/grok-bot/grok-bot-agent-client";
import {
  transcriptActivityAfterPrompt,
  transcriptToMessages,
  transcriptToolSteps,
} from "../src/backend/grok-bot/grok-bot-transcript";
import { decodeThreadResponse, decodeTurnResponse } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/grok-bot-transcript-tools-e2e");
const REPLY = "Hello from Grok Bot";
const TOOL_REPLY = "Done with the tool";
const WAIT_REPLY = "Finished after the tool";
const FAIL_REPLY = "The tool failed";
const PERMISSION_REPLY = "Allowed";
const cipher = {
  encrypt: (value: string) => Buffer.from(value, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8"),
};

const report: {
  passed: boolean;
  textReply: string;
  toolNames: string[];
  toolStatuses: string[];
  waitingHeld: boolean;
  permissionHeld: boolean;
  failedToolStatus: string;
  noToolCallRequest: boolean;
  noDirectStream: boolean;
  directInferenceOmitted: boolean;
} = {
  passed: false,
  textReply: "",
  toolNames: [],
  toolStatuses: [],
  waitingHeld: false,
  permissionHeld: false,
  failedToolStatus: "",
  noToolCallRequest: false,
  noDirectStream: false,
  directInferenceOmitted: false,
};

const textTail = {
  entries: [
    { id: "t1u", kind: "message", role: "user", content: "text only" },
    { kind: "not-a-card", id: "mystery" },
    { id: "t1s0", kind: "send-message", message: { type: "text", content: REPLY } },
    { id: "t1s1", kind: "send-message", message: { type: "text", content: "sent to slack", channel: "slack" } },
  ],
};

const toolTail = {
  entries: [
    { id: "t0u", kind: "message", role: "user", content: "old" },
    { id: "t0c", kind: "tool-call", name: "Read", status: "done", summary: "old file" },
    { id: "t0s", kind: "send-message", message: { type: "text", content: "old reply" } },
    { id: "t2u", kind: "message", role: "user", content: "use the tool" },
    { kind: "not-a-card", id: "mystery-2" },
    { id: "t2c0", kind: "tool-call", name: "Shell", status: "done", summary: "listed files" },
    { id: "t2c1", kind: "tool-call", toolName: "Read", status: "done", summary: "notes" },
    { id: "", kind: "tool-call", name: "Skip", status: "done" },
    { id: "t2c2", kind: "tool-call", name: "", status: "done" },
    { id: "t2s0", kind: "send-message", message: { type: "text", content: TOOL_REPLY } },
  ],
};

function oneToolTail() {
  return {
    entries: [
      { id: "t9u", kind: "message", role: "user", content: "one tool" },
      { kind: "not-a-card", noise: true },
      { id: "t9c", kind: "tool-call", name: "Shell", status: "done", summary: "listed files" },
      { id: "t9s", kind: "send-message", message: { type: "text", content: "One sentence" } },
    ],
  };
}

function assertParser(): void {
  const odd = transcriptToolSteps({ entries: [null, 1, "x", { kind: "tool-call" }] });
  assert.deepEqual(odd, []);
  assert.deepEqual(transcriptToolSteps(null), []);
  assert.deepEqual(transcriptToolSteps(textTail), []);
  const textMessage = transcriptToMessages(textTail).at(-1);
  assert.equal(textMessage && "text" in textMessage ? textMessage.text : "", REPLY);

  const one = transcriptToolSteps(oneToolTail());
  assert.equal(one.length, 1);
  assert.equal(one[0]?.name, "Shell");
  assert.equal(one[0]?.status, "completed");
  assert.equal(one[0]?.detail, "listed files");
  const oneMessage = transcriptToMessages(oneToolTail()).at(-1);
  assert.equal(oneMessage && "text" in oneMessage ? oneMessage.text : "", "One sentence");

  const after = transcriptActivityAfterPrompt(toolTail, "use the tool");
  assert.deepEqual(
    after.steps.map((step) => step.name),
    ["Shell", "Read"],
  );
  assert.equal(after.permissionPending, false);
  assert.equal(
    transcriptToolSteps(toolTail).some((step) => step.id === "t0c"),
    true,
  );

  const failed = transcriptToolSteps({
    entries: [{ id: "e", kind: "tool-call", name: "Shell", status: "error", summary: "disk full" }],
  });
  assert.equal(failed[0]?.status, "failed");
  const pending = transcriptToolSteps({
    entries: [{ id: "p", kind: "tool-call", name: "Shell", status: "running" }],
  });
  assert.equal(pending[0]?.status, "inProgress");
  const aborted = transcriptToolSteps({
    entries: [{ id: "a", kind: "tool-call", name: "Shell", status: "aborted" }],
  });
  assert.equal(aborted[0]?.status, "completed");
  const named = transcriptToolSteps({
    entries: [{ id: "n", kind: "tool-call", toolName: "Read", status: "done" }],
  });
  assert.equal(named[0]?.name, "Read");
  assert.equal(named[0]?.detail, "");
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((ready, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => ready(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

type Mode = "text" | "tool" | "wait" | "fail" | "permission";

assertParser();

const drivers = readFileSync(resolve(import.meta.dirname, "../src/backend/provider-drivers.ts"), "utf8");
const grokBot = drivers.slice(drivers.indexOf('id: "grok-bot"'), drivers.indexOf('id: "acp"'));
report.directInferenceOmitted = !grokBot.includes("directInference");
assert.equal(report.directInferenceOmitted, true);

const root = await mkdtemp(join(tmpdir(), "openbot-grok-bot-tools-"));
const authFile = join(root, "grok-account.json");
let mode: Mode = "text";
let arm = false;
let polls = 0;
let released = false;
let streamCalls = 0;
let addressPort = 0;
const toolRequests: string[] = [];

function liveEntries(): unknown[] {
  if (mode === "text") return textTail.entries;
  if (mode === "tool") return toolTail.entries;
  if (mode === "fail") {
    return [
      { id: "t4u", kind: "message", role: "user", content: "tool fails" },
      { id: "t4c", kind: "tool-call", name: "Shell", status: "error", summary: "disk full" },
      { id: "t4s", kind: "send-message", message: { type: "text", content: FAIL_REPLY } },
    ];
  }
  const open = !released;
  if (mode === "wait") {
    return [
      { id: "t3u", kind: "message", role: "user", content: "wait for the tool" },
      {
        id: "t3c",
        kind: "tool-call",
        name: "Shell",
        status: open ? "running" : "done",
        summary: open ? "still running" : "listed files",
      },
      { id: "t3s", kind: "send-message", message: { type: "text", content: WAIT_REPLY } },
    ];
  }
  return [
    { id: "t5u", kind: "message", role: "user", content: "need permission" },
    {
      id: "t5p",
      kind: "send-message",
      message: {
        type: "local-tool-permission",
        ask: { requestId: "r1", status: open ? "pending" : "allow-once", action: "read-file" },
      },
    },
    { id: "t5s", kind: "send-message", message: { type: "text", content: PERMISSION_REPLY } },
  ];
}

const server = createServer((request, response: ServerResponse) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    if (url.pathname === "/aiserver.v1.GrokBotService/EnsureSandBox") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ gatewayUrl: `http://127.0.0.1:${addressPort}`, gatewayToken: "gw-e2e" }));
      return;
    }
    if (url.pathname === "/api/createAgent") {
      assert.equal(request.headers.authorization, "Bearer gw-e2e");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ agent: { id: "sand-agent-e2e", name: "OpenBot" } }));
      return;
    }
    if (url.pathname === "/api/sendPrompt") {
      assert.equal(request.headers.authorization, "Bearer gw-e2e");
      const parsed = JSON.parse(body);
      assert.equal(isDynamicRecord(parsed) && typeof parsed.prompt === "string" && parsed.prompt.length > 0, true);
      arm = true;
      polls = 0;
      released = false;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    if (url.pathname === "/api/getAgentTranscriptTail") {
      response.writeHead(200, { "content-type": "application/json" });
      if (!arm) {
        response.end(JSON.stringify({ entries: [] }));
        return;
      }
      polls += 1;
      if ((mode === "wait" || mode === "permission") && polls >= 4) released = true;
      response.end(JSON.stringify({ entries: liveEntries() }));
      return;
    }
    if (url.pathname === "/aiserver.v1.InferenceService/Stream") {
      streamCalls += 1;
      response.writeHead(500).end();
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
addressPort = bound.port;

interface Note {
  method: string;
  params: unknown;
}

interface ToolRow {
  readonly id: unknown;
  readonly namespace: unknown;
  readonly tool: unknown;
  readonly status: unknown;
  readonly contentItems: unknown;
}

function toolRows(notes: readonly Note[], method: string): ToolRow[] {
  return notes.flatMap((note) => {
    if (note.method !== method || !isDynamicRecord(note.params) || !isDynamicRecord(note.params.item)) return [];
    const item = note.params.item;
    if (item.type !== "dynamicToolCall") return [];
    return [
      {
        id: item.id,
        namespace: item.namespace,
        tool: item.tool,
        status: item.status,
        contentItems: item.contentItems,
      },
    ];
  });
}

function assistantText(notes: readonly Note[]): string {
  return notes
    .filter((note) => note.method === "item/agentMessage/delta")
    .map((note) => (isDynamicRecord(note.params) && typeof note.params.delta === "string" ? note.params.delta : ""))
    .join("");
}

async function runTurn(client: GrokBotAgentClient, threadId: string, prompt: string, nextMode: Mode): Promise<Note[]> {
  arm = false;
  mode = nextMode;
  const notes: Note[] = [];
  const onNote = (notification: Note) => notes.push(notification);
  client.on("notification", onNote);
  await Effect.runPromise(
    client.request(
      "turn/start",
      { threadId, model: "default", input: [{ type: "text", text: prompt }] },
      decodeTurnResponse,
    ),
  );
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn did not finish: ${prompt}`)), 4_000);
    const done = () => {
      const completed = notes.find((note) => note.method === "turn/completed");
      if (!completed || !isDynamicRecord(completed.params) || !isDynamicRecord(completed.params.turn)) return;
      clearTimeout(timer);
      client.off("notification", done);
      ready();
    };
    client.on("notification", done);
    done();
  });
  client.off("notification", onNote);
  return notes;
}

try {
  const store = new GrokBotAccountStore(authFile, cipher);
  await Effect.runPromise(
    store.save({ accessToken: "grok-access-e2e", refreshToken: "grok-refresh-e2e", gateway: null }),
  );
  const client = new GrokBotAgentClient({
    store,
    apiBaseUrl: `http://127.0.0.1:${addressPort}`,
    allowLoopback: true,
    gatewayPollMs: 20,
    gatewayTurnTimeoutMs: 3_000,
  });
  client.on("request", (request) => toolRequests.push(request.method));
  client.start();
  const started = await Effect.runPromise(
    client.request("thread/start", { developerInstructions: "Be brief." }, decodeThreadResponse),
  );
  assert.equal(started.thread.id, "sand-agent-e2e");

  const textNotes = await runTurn(client, started.thread.id, "text only", "text");
  report.textReply = assistantText(textNotes);
  assert.equal(report.textReply, REPLY);
  assert.equal(toolRows(textNotes, "item/completed").length, 0);
  const textTurn = textNotes.find((note) => note.method === "turn/completed");
  assert.equal(
    isDynamicRecord(textTurn?.params) && isDynamicRecord(textTurn.params.turn) && textTurn.params.turn.status,
    "completed",
  );

  const toolNotes = await runTurn(client, started.thread.id, "use the tool", "tool");
  const completedTools = toolRows(toolNotes, "item/completed");
  report.toolNames = completedTools.map((item) => (typeof item.tool === "string" ? item.tool : ""));
  report.toolStatuses = completedTools.map((item) => (typeof item.status === "string" ? item.status : ""));
  assert.deepEqual(report.toolNames, ["Shell", "Read"]);
  assert.deepEqual(report.toolStatuses, ["completed", "completed"]);
  assert.equal(
    completedTools.every((item) => item.namespace === "sand"),
    true,
  );
  assert.equal(
    completedTools.some((item) => item.id === "t0c"),
    false,
  );
  assert.equal(assistantText(toolNotes), TOOL_REPLY);
  const shell = completedTools.find((item) => item.id === "t2c0");
  const shellDetail = Array.isArray(shell?.contentItems) ? shell.contentItems[0] : undefined;
  assert.equal(isDynamicRecord(shellDetail) && shellDetail.text, "listed files");
  const startedTools = toolRows(toolNotes, "item/started");
  assert.deepEqual(
    startedTools.map((item) => item.id),
    ["t2c0", "t2c1"],
  );

  const waitNotes = await runTurn(client, started.thread.id, "wait for the tool", "wait");
  report.waitingHeld = released && assistantText(waitNotes) === WAIT_REPLY;
  assert.equal(report.waitingHeld, true);
  const waitTool = toolRows(waitNotes, "item/completed").find((item) => item.id === "t3c");
  assert.equal(waitTool?.status, "completed");
  const waitStatus = waitNotes.find((note) => note.method === "turn/completed");
  assert.equal(
    isDynamicRecord(waitStatus?.params) && isDynamicRecord(waitStatus.params.turn) && waitStatus.params.turn.status,
    "completed",
  );

  const failNotes = await runTurn(client, started.thread.id, "tool fails", "fail");
  const failedTool = toolRows(failNotes, "item/completed").find((item) => item.id === "t4c");
  report.failedToolStatus = typeof failedTool?.status === "string" ? failedTool.status : "";
  assert.equal(report.failedToolStatus, "failed");
  assert.equal(assistantText(failNotes), FAIL_REPLY);

  const permissionNotes = await runTurn(client, started.thread.id, "need permission", "permission");
  report.permissionHeld = released && assistantText(permissionNotes) === PERMISSION_REPLY;
  assert.equal(report.permissionHeld, true);
  assert.equal(toolRows(permissionNotes, "item/completed").length, 0);
  assert.equal(toolRows(permissionNotes, "item/started").length, 0);

  report.noToolCallRequest = !toolRequests.includes("item/tool/call");
  report.noDirectStream = streamCalls === 0;
  assert.equal(report.noToolCallRequest, true);
  assert.equal(report.noDirectStream, true);
  await Effect.runPromise(client.stop());
  report.passed = true;
} finally {
  await new Promise<void>((ready, reject) => server.close((error) => (error ? reject(error) : ready())));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exit(1);
