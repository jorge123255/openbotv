// The shared Cursor poll returns tokens and writes no auth file.
// bun scripts/cursor-login-poll-e2e.ts
// Writes .openbot-build/cursor-login-poll-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { cursorLoginHandshake, pollCursorLoginTokens } from "../src/backend/agent/cursor-login-poll";

const OUT = resolve(import.meta.dirname, "../.openbot-build/cursor-login-poll-e2e");
const ACCESS = "grok-access-e2e";
const REFRESH = "grok-refresh-e2e";

const report = { passed: false, redirectTarget: "", wroteFile: true, tokens: false };

const root = await mkdtemp(join(tmpdir(), "openbot-cursor-login-poll-"));
const server = createServer((request, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/auth/poll") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH }));
});
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert.ok(address !== null && typeof address === "object");

try {
  const handshake = cursorLoginHandshake("https://cursor.com");
  const page = new URL(handshake.loginUrl);
  report.redirectTarget = page.searchParams.get("redirectTarget") ?? "";
  assert.equal(page.origin, "https://cursor.com");
  assert.equal(page.pathname, "/loginDeepControl");
  assert.equal(page.searchParams.get("mode"), "login");
  assert.equal(report.redirectTarget, "cli");
  assert.ok((page.searchParams.get("challenge")?.length ?? 0) > 0);
  assert.equal(page.searchParams.get("uuid"), handshake.uuid);
  assert.equal(handshake.loginUrl.includes(handshake.verifier), false);

  const tokens = await Effect.runPromise(
    pollCursorLoginTokens({
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
      uuid: handshake.uuid,
      verifier: handshake.verifier,
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
      delay: () => 0,
    }),
  );
  report.tokens = tokens.accessToken === ACCESS && tokens.refreshToken === REFRESH;
  assert.equal(report.tokens, true);
  report.wroteFile = (await readdir(root)).length > 0;
  assert.equal(report.wroteFile, false);
  report.passed = true;
} finally {
  await new Promise<void>((ready, reject) => server.close((error) => (error ? reject(error) : ready())));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exit(1);
