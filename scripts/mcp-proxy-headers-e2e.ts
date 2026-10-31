// Drive the real OAuth proxy against a loopback server that checks MCP routing headers.
// No account or live provider is used. Writes .openbot-build/mcp-proxy-headers-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { McpOAuthProxy } from "../src/backend/mcp-oauth-proxy";

const OUT = resolve(import.meta.dirname, "../.openbot-build/mcp-proxy-headers-e2e");
const cases: string[] = [];
const hits: Array<{ path: string; headers: import("node:http").IncomingHttpHeaders; body: string }> = [];
let refreshed = 0;
const routes = { headers: "0".repeat(32), redirect: "1".repeat(32), refresh: "2".repeat(32) };
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  hits.push({ path: request.url ?? "/", headers: request.headers, body });
  if (request.url === "/redirect") {
    response.writeHead(307, { location: "/mcp" });
    response.end();
    return;
  }
  if (request.url === "/refresh" && request.headers.authorization === "Bearer fixture-upstream") {
    response.writeHead(401);
    response.end();
    return;
  }
  const parsed = JSON.parse(body);
  const mismatch =
    parsed.method === "server/discover"
      ? request.headers["mcp-method"] !== parsed.method
      : parsed.method === "tools/call" &&
        (request.headers["mcp-method"] !== parsed.method ||
          request.headers["mcp-name"] !== parsed.params.name ||
          request.headers["mcp-param-region"] !== parsed.params.arguments.region);
  response.writeHead(mismatch ? 400 : 200, { "content-type": "application/json" });
  response.end(
    JSON.stringify(
      mismatch
        ? { jsonrpc: "2.0", id: parsed.id, error: { code: -32020, message: "Header mismatch" } }
        : { jsonrpc: "2.0", id: parsed.id, result: {} },
    ),
  );
});
let base = "";
const proxy = new McpOAuthProxy({
  settings: null,
  target: (route) =>
    Effect.succeed({
      url: `${base}/${route === routes.redirect ? "redirect" : route === routes.refresh ? "refresh" : "mcp"}`,
      headers: [{ key: "x-row-key", value: "fixture-row" }],
      token: "fixture-upstream",
    }),
  refresh: (_url, rejected) => {
    assert.equal(rejected, "fixture-upstream");
    refreshed++;
    return Effect.succeed("fixture-renewed");
  },
});
let passed = false;
let error: string | undefined;
try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  const route = await runCauseEffect(proxy.route(routes.headers));
  const discover = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
  const routing = { "Mcp-Method": "server/discover", "MCP-Protocol-Version": "2026-07-28" };
  const post = async (endpoint: typeof route, body: string, headers: Record<string, string>) => {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(3_000),
    });
    await response.text();
    return response.status;
  };
  assert.equal(await post(route, discover, routing), 200, "The proxy dropped the MCP method header.");
  assert.equal(hits.at(-1)?.headers["mcp-protocol-version"], "2026-07-28");
  cases.push("discovery method and protocol reach the server");

  const named = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "fixture-tool",
      arguments: { region: "fixture-region" },
    },
  });
  const namedHeaders = {
    "Mcp-Method": "tools/call",
    "Mcp-Name": "fixture-tool",
    "Mcp-Param-Region": "fixture-region",
  };
  assert.equal(await post(route, named, namedHeaders), 200, "The proxy dropped the MCP name or parameter header.");
  assert.equal(hits.at(-1)?.body, named);
  cases.push("tool name and parameter reach the server with unchanged body");

  const encoded = "=?base64?Zml4dHVyZS10b29s?=";
  assert.equal(await post(route, discover, { ...routing, "Mcp-Name": encoded, "Mcp-Param-Text": encoded }), 200);
  assert.equal(hits.at(-1)?.headers["mcp-name"], encoded);
  assert.equal(hits.at(-1)?.headers["mcp-param-text"], encoded);
  cases.push("encoded header values stay unchanged");

  assert.equal(await post(route, discover, { ...routing, "Mcp-Method": "tools/list" }), 400);
  cases.push("server still rejects mismatched method and body");

  const legacy = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
  assert.equal(
    await post(route, legacy, { cookie: "fixture-cookie", "x-untrusted": "fixture", "proxy-authorization": "fixture" }),
    200,
  );
  const legacyHit = hits.at(-1);
  assert.equal(legacyHit?.headers["mcp-method"], undefined);
  assert.equal(legacyHit?.headers.cookie, undefined);
  assert.equal(legacyHit?.headers["x-untrusted"], undefined);
  assert.equal(legacyHit?.headers["proxy-authorization"], undefined);
  assert.equal(legacyHit?.headers.authorization, "Bearer fixture-upstream");
  assert.equal(legacyHit?.headers["x-row-key"], "fixture-row");
  cases.push("legacy requests and credential header boundary stay intact");

  assert.equal(await post(await runCauseEffect(proxy.route(routes.redirect)), named, namedHeaders), 200);
  assert.equal(hits.at(-1)?.path, "/mcp");
  cases.push("routing headers survive a same-origin redirect");

  assert.equal(await post(await runCauseEffect(proxy.route(routes.refresh)), named, namedHeaders), 200);
  assert.equal(refreshed, 1);
  assert.equal(hits.at(-1)?.headers.authorization, "Bearer fixture-renewed");
  cases.push("routing headers survive an OAuth refresh");

  const count = hits.length;
  assert.equal(await post({ ...route, bearer: "fixture-wrong" }, discover, routing), 403);
  assert.equal(hits.length, count);
  cases.push("invalid route bearer never reaches upstream");
  passed = true;
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
  process.exitCode = 1;
} finally {
  await runCauseEffect(proxy.close());
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify({ passed, cases, error }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed, cases, error })}\n`);
}
