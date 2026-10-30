// The Cursor sign-in OpenBot shares with BotAI: loginDeepControl, then GET /auth/poll.
// A local poll stands in for api2.cursor.sh. No Cursor account is used.
// bun scripts/cursor-deep-login-e2e.ts
// Writes .openbot-build/cursor-deep-login-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { startCursorDeepLogin } from "../src/backend/agent/cursor-deep-login";

const OUT = resolve(import.meta.dirname, "../.openbot-build/cursor-deep-login-e2e");
function authFields(value: unknown): { accessToken: string; refreshToken: string } {
  if (typeof value !== "object" || value === null || !("accessToken" in value) || !("refreshToken" in value)) {
    assert.fail("The auth file is not a Cursor sign-in.");
  }
  const { accessToken, refreshToken } = value;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    assert.fail("The auth file is not a Cursor sign-in.");
  }
  return { accessToken, refreshToken };
}

const ACCESS = "cursor-access-e2e";
const REFRESH = "cursor-refresh-e2e";

const root = await mkdtemp(join(tmpdir(), "openbot-cursor-deep-login-"));
const authFile = join(root, "auth.json");

async function listen(
  handler: (polls: { count: number }, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const polls = { count: 0 };
  const server = createServer((request, response) => {
    if (!request.url?.startsWith("/auth/poll")) {
      response.writeHead(404).end();
      return;
    }
    polls.count += 1;
    handler(polls, response);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((ready, reject) => server.close((error) => (error ? reject(error) : ready()))),
  };
}

const report: { passed: boolean; link: boolean; polls: number; stored: boolean; refused: boolean } = {
  passed: false,
  link: false,
  polls: 0,
  stored: false,
  refused: false,
};

try {
  const approved = await listen((polls, response) => {
    if (polls.count === 1) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH }));
  });
  try {
    const prompt = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* startCursorDeepLogin({
            timeoutMs: 10_000,
            websiteUrl: "https://cursor.com",
            apiBaseUrl: approved.url,
            authFile,
            delay: () => 0,
          });
          const page = yield* started.prompt ?? Effect.die("The sign-in did not return a page.");
          yield* started.done;
          return page;
        }),
      ),
    );
    assert.equal(prompt.flow, "link");
    const page = new URL(prompt.verificationUrl);
    report.link =
      page.origin === "https://cursor.com" &&
      page.pathname === "/loginDeepControl" &&
      page.searchParams.get("mode") === "login" &&
      page.searchParams.get("redirectTarget") === "cli" &&
      (page.searchParams.get("challenge")?.length ?? 0) > 0 &&
      (page.searchParams.get("uuid")?.length ?? 0) > 0;
    assert.equal(report.link, true);
  } finally {
    await approved.close();
  }
  const stored = authFields(JSON.parse(readFileSync(authFile, "utf8")));
  report.stored = stored.accessToken === ACCESS && stored.refreshToken === REFRESH;
  report.polls = 2;
  assert.equal(report.stored, true);
  assert.equal(statSync(authFile).mode & 0o777, 0o600);

  const refusedFile = join(root, "refused.json");
  const refused = await listen((_polls, response) => {
    response.writeHead(500).end();
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* startCursorDeepLogin({
            timeoutMs: 10_000,
            websiteUrl: "https://cursor.com",
            apiBaseUrl: refused.url,
            authFile: refusedFile,
            delay: () => 0,
          });
          return yield* started.done;
        }),
      ),
    );
    assert.fail("A refused poll must not sign Cursor in.");
  } catch {
    report.refused = true;
  } finally {
    await refused.close();
  }
  assert.equal(report.refused, true);
  assert.throws(() => readFileSync(refusedFile, "utf8"));
  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

if (!report.passed) process.exit(1);
