// The Grok Bot account file stays apart from the Cursor CLI auth file.
// bun scripts/grok-bot-account-e2e.ts
// Writes .openbot-build/grok-bot-account-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { redactText } from "@openbot/logging";
import { Effect } from "effect";
import { GrokBotAccountStore, publicGrokBotStatus, startGrokBotSignIn } from "../src/backend/grok-bot/grok-bot-account";

const OUT = resolve(import.meta.dirname, "../.openbot-build/grok-bot-account-e2e");
const ACCESS = "grok-access-e2e";
const REFRESH = "grok-refresh-e2e";
const CLI_JSON = `${JSON.stringify({ accessToken: "cli-access", refreshToken: "cli-refresh" }, null, 2)}\n`;

const cipher = {
  encrypt: (value: string) => Buffer.from(value, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8"),
};

const report = {
  passed: false,
  redirectTarget: "",
  cliUntouched: false,
  stored: false,
  statusHidesToken: false,
  redacted: false,
  signedOut: false,
};

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

const root = await mkdtemp(join(tmpdir(), "openbot-grok-bot-account-"));
const cliFile = join(root, "cli-auth.json");
const authFile = join(root, "grok-account.json");
writeFileSync(cliFile, CLI_JSON);

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
    const started = await Effect.runPromise(
      startGrokBotSignIn({
        timeoutMs: 5_000,
        authFile,
        cipher,
        websiteUrl: "https://cursor.com",
        apiBaseUrl: approved.url,
        delay: () => 0,
        signal: new AbortController().signal,
      }),
    );
    const page = new URL(started.verificationUrl);
    report.redirectTarget = page.searchParams.get("redirectTarget") ?? "";
    assert.equal(report.redirectTarget, "cli");
    assert.equal(started.verificationUrl.includes(REFRESH), false);
    assert.equal(started.verificationUrl.includes("verifier="), false);
    const record = await Effect.runPromise(started.done);
    report.cliUntouched = readFileSync(cliFile, "utf8") === CLI_JSON;
    assert.equal(report.cliUntouched, true);
    const mode = statSync(authFile).mode & 0o777;
    const stored = JSON.parse(readFileSync(authFile, "utf8"));
    if (!isDynamicRecord(stored) || typeof stored.payload !== "string")
      throw new Error("The account file is unreadable.");
    const plain = cipher.decrypt(Buffer.from(stored.payload, "base64"));
    report.stored = mode === 0o600 && plain.includes(ACCESS) && !plain.includes("cli-access");
    assert.equal(report.stored, true);
    const status = publicGrokBotStatus(record);
    report.statusHidesToken = status.signedIn === true && !JSON.stringify(status).includes(ACCESS);
    assert.equal(report.statusHidesToken, true);
    report.redacted = redactText(`token ${ACCESS}`) === "token [redacted]";
    assert.equal(report.redacted, true);
    const store = new GrokBotAccountStore(authFile, cipher);
    await Effect.runPromise(store.clear());
    const cleared = await Effect.runPromise(store.load());
    report.signedOut = cleared === null && readFileSync(cliFile, "utf8") === CLI_JSON;
    assert.equal(report.signedOut, true);
    report.passed = true;
  } finally {
    await approved.close();
  }
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exit(1);
