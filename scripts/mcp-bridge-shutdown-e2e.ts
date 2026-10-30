// A provider keeps its HTTP connection to the local OpenBot MCP bridge until its process ends.
// The process ends only after the bridge closes. This check starts one tool call and leaves it
// open, then closes the bridge. The close must return while that call is still open.
// `bun run test:mcp-bridge-shutdown`. Writes .openbot-build/mcp-bridge-shutdown-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { type ClientRequest, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { LocalMcpBridge } from "../src/backend/local-mcp-bridge";
import type { DynamicToolResult } from "../src/backend/protocol";
import type { ProviderClientOperationError } from "../src/backend/provider-client-effects";

const OUT = resolve(import.meta.dirname, "../.openbot-build/mcp-bridge-shutdown-e2e");
const CLOSE_LIMIT_MS = 1_000;

const report: { passed: boolean; closeMs?: number; error?: string } = { passed: false };
const bridge = new LocalMcpBridge();
let heldCall: ClientRequest | null = null;
let markStarted: (() => void) | undefined;

try {
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const session = await runCauseEffect(
    bridge.createSession(
      "thread-1",
      [
        {
          type: "namespace",
          name: "openbot",
          tools: [
            {
              type: "function",
              name: "channel_assign",
              description: "Assign one subtask.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      ],
      () => "turn-1",
      () =>
        Effect.callback<DynamicToolResult, ProviderClientOperationError>(() => {
          markStarted?.();
          return Effect.void;
        }),
    ),
  );
  const server = session.servers[0];
  assert.ok(server);
  const url = new URL(server.url);
  const authorization = server.headers.find((header) => header.name === "Authorization")?.value;
  assert.ok(authorization);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "channel_assign", arguments: {} },
  });
  await new Promise<void>((resolve) => {
    const next = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
      },
    );
    heldCall = next;
    next.on("error", () => {
      // The close drops the socket. That is the end of the held connection.
    });
    next.on("socket", (socket) => {
      if (socket.readyState === "open") resolve();
      else socket.once("connect", () => resolve());
    });
    next.end(body);
  });
  await Promise.race([
    started,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The tool call did not start.")), 2_000)),
  ]);
  const startedAt = Date.now();
  const closed = runCauseEffect(bridge.close());
  const outcome = await Promise.race([
    closed.then(() => "closed" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), CLOSE_LIMIT_MS)),
  ]);
  report.closeMs = Date.now() - startedAt;
  assert.equal(outcome, "closed", `The bridge close took ${report.closeMs} ms.`);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  endHeldCall(heldCall);
  await runCauseEffect(bridge.close()).catch(() => {});
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function endHeldCall(call: ClientRequest | null) {
  call?.destroy();
}
