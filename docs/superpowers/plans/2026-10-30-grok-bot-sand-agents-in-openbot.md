# Grok Bot sand account and agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in to a Grok Bot (Cursor sand) account inside OpenBot, list and create the real Grok Bot agents for that account, and show that account's sand usage beside provider usage.

**Architecture:** Reuse the BotAI desktop login: PKCE, `loginDeepControl`, and `GET /auth/poll`, with `redirectTarget=cli`. Store the tokens in an OpenBot secret file. Do not write the Cursor CLI auth file or the `cursor-access-token` keychain item. After login, exchange the access token with `EnsureSandBox`, then call the sand gateway `listAgents` and `createAgent`. Read sand usage with that same account token (`GetSandUsageStatus` and `GetCurrentPeriodUsage`). Show it on the page-rail usage rings and in the Grok Bot settings section. The label is "Grok Bot". The Cursor provider dock keeps `readCursorUsage`. The settings panel is local to this computer. The Cursor provider Connect path and the Grok Bot zip import stay as they are.

**Tech Stack:** Effect 4.0.0, Electron `safeStorage`, existing IPC groups (`packages/contracts`, `src/main/ipc`, `src/preload`, `src/renderer/src/preview/mock-openbot.ts`), SolidJS settings UI, `@openbot/i18n` catalog keys, e2e scripts under `scripts/`.

## Global Constraints

- Fork only: `jorge123255/openbotv`. Do not open a pull request against upstream OpenBot.
- This plan does not rebuild, install, or release OpenBot. It does not undraft or merge a pull request.
- Keep `src/backend/agent/cursor-deep-login.ts` as the Cursor **provider** Connect path. `provider-drivers.ts` keeps `codeSignIn: { kind: "cursor-deep", timeoutMs: CLI_LOGIN_TIMEOUT_MS }` for the Cursor provider. Do not add a Grok Bot provider id.
- Keep Server settings → Import and `resources/agent-import/grok-bot/SKILL.md`. The zip import still creates local OpenBot agents. This plan does not replace it.
- `redirectTarget` is the constant `cli`. Do not read an environment value that can set it to `sand`. Do not call `app.setAsDefaultProtocolClient("sand")`. The only protocol registration stays `openbot` in `presentApplication` at `src/main/index.ts`.
- `x-cursor-client-type: sand` is an HTTP header on the Cursor backend call. It is not a URL scheme.
- The Grok Bot account file must not use the macOS keychain service `cursor-access-token` or the account `cursor-user`. Those names already belong to the Cursor CLI sign-in in `writeCursorAuth`.
- No personal tokens, API keys, or live session cookies in code, tests, logs, or this plan. Test fixtures use the strings `grok-access-e2e` and `grok-refresh-e2e`.
- No database migration. No Team API protocol, capability, or route. No iPhone app change.
- User-visible text comes from `@openbot/i18n`. Main and backend errors use `sourceText(key)`.
- Use Effect 4.0.0 (`Effect.fn`, `Effect.gen`, `Schema.TaggedError`). Do not add a paired Promise method on the service.
- Decode untrusted IPC and HTTP bodies at the boundary. Do not share one decoder between main and the preload.
- Register every token with `registerSecretValue` from `@openbot/logging` before a log, an error, or a poll URL can carry it. Do not put a token in an IPC result or event.
- Tests are e2e scripts under `scripts/` that write a JSON report. Do not add a vitest file. Run the existing `src/main/ipc-channel-coverage.test.ts` after the IPC group exists. It is already a trust-boundary test.
- Do not run `bun run typecheck`, `bun run format`, or a full test suite. Run one command at a time.
- PolyForm Noncommercial 1.0.0 stays. Do not add a dependency.

## Verified facts

`jorge123255/botai` returned HTTP 404 to the token on this machine on 2026-10-30. Do not clone it. These facts come from George's BotAI checkout and from code in this fork.

Login, from `source/electron-main/account/cursor-auth.ts` and `source/electron-main/auth/auth-callback-registration.ts`:

- Verifier: 32 random bytes, then base64url.
- Challenge: `createHash("sha256").update(verifier).digest("base64url")`. Hash the base64url **string** (Node hashes a string as UTF-8). Do not hash the raw 32 bytes.
- Page: `https://cursor.com/loginDeepControl?challenge=…&uuid=…&mode=login&redirectTarget=cli`.
- BotAI names the target `SAND_AUTH_REDIRECT_TARGET`. The desktop default is `cli` so BotAI does not take the official Grok Bot `sand://` callback. The poll completes the login.
- Poll: `GET https://api2.cursor.sh/auth/poll?uuid=…&verifier=…`. HTTP 404 means wait. HTTP 200 is `{ accessToken, refreshToken }`. Stop after 150 attempts. The delay grows from 1 s to 10 s (`min(1000 * 1.2 ** attempt, 10000)`).
- BotAI stores the tokens as secrets named `cursor-access-token` and `cursor-refresh-token`. That store is the sand account. It is not the Cursor CLI auth file.

This fork already implements that handshake for the **provider** in `src/backend/agent/cursor-deep-login.ts`. `redirectTarget` is hard-coded `"cli"` (line 76). `scripts/cursor-deep-login-e2e.ts` asserts `redirectTarget=cli`. On success it writes `cursorAuthFile()` and, on macOS, the keychain item `cursor-access-token` / `cursor-user`. That write stays on the provider path only.

Agents after login, from `source/shared/rpc/coordinator.ts`:

- The product calls are `listAgents`, `createAgent`, and `createAgentFromTemplate`.
- They use the sand account session, not an OpenBot local agent profile.

The coordinator file was not readable here. The same method names `listAgents` and `createAgent` are documented as gateway calls in `grokbot_api` 1.2.0 (https://docs.rs/grokbot_api/1.2.0/grokbot_api/guide/protocol/index.html). This plan uses that wire:

1. `POST https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox` with body `{}` and the access token. A Cursor dashboard API key does not work. The poll access token does.
2. The response gives `gatewayUrl` and `gatewayToken`.
3. `POST {gatewayUrl}/api/listAgents` with `{}`.
4. `POST {gatewayUrl}/api/createAgent` with the body in Task 4.

`createAgentFromTemplate` is not in the `grokbot_api` 1.2.0 method table, and the verified notes do not give its fields. This plan does not send it. See Non-goals.

Hypothesis, checked: `redirectTarget=cli` plus the poll is enough for the session. The poll returns the access token. `EnsureSandBox` takes that token. The same token is the sand access token BotAI sends to the dashboard RPCs below. The `sand://` callback is not required. Mobile BotAI docs can still say `redirectTarget=sand`. Desktop OpenBot follows desktop BotAI and uses `cli`.

Sand usage, from BotAI `source/electron-main/account/cursor-profile.ts`. The account menu calls `bridge.cursorAccount.getUsageSummary()` when the sand account is signed in. `fetchSandUsageSummary` and `fetchSandWeeklyUsage` send the sand access token to Cursor dashboard RPCs:

- `getSandUsageStatus` returns `sandUsagePercent`, `nextResetTimestampUtc`, `hasAvailableUsage`, trial fields, and `upgradeRecommendation`.
- `getCurrentPeriodUsage` returns on-demand `spendLimitUsage` (`individualUsed`, `individualLimit`) and `billingCycleEnd`.
- `getTeams` and `getSandTrialClaimStatus` feed the enterprise and trial calls to action.

OpenBot already reads Cursor **provider** usage in `src/backend/cursor-usage.ts`: `GetCurrentPeriodUsage` and `GetPlanInfo` with the CLI token. That reading fills the provider dock (`autoPercentUsed`, `apiPercentUsed`, `totalPercentUsed`). It is not sand usage. This plan does not change that function.

Public Connect paths for the same RPCs, used by this plan:

- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus`
- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetTeams`
- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandTrialClaimStatus`

Each body is `{}`. Headers match Task 4's sand backend call: `Authorization: Bearer <Grok Bot account access token>`, `Content-Type: application/json`, `connect-protocol-version: 1`, `x-cursor-client-type: sand`, `x-cursor-client-version: 0.70.2`, `x-sand-box-namespace: prod`. Do not send a checksum header. Do not send the CLI token.

## Non-goals

- Do not chat with a Grok Bot agent (`sendPrompt`, transcripts, approvals).
- Do not call `createAgentFromTemplate`. Add it only in a later plan that copies the argument object from `source/shared/rpc/coordinator.ts`. Do not guess the JSON.
- Do not list team agents (`ListGrokBotTeamAgents`).
- Do not import a created Grok Bot agent into the local OpenBot agent store.
- Do not change `apps/mobile`.
- Do not show this account on the web client or on a joined server.
- Do not refresh the Cursor CLI auth file when the Grok Bot token refreshes.
- Do not fold sand usage into `readCursorUsage` or into `AccountUsage.limits`. The Cursor provider dock stays on the CLI token.

## File map

| File | Responsibility |
| --- | --- |
| `src/backend/agent/cursor-login-poll.ts` | PKCE page and poll. Returns tokens. Writes nothing. |
| `src/backend/agent/cursor-deep-login.ts` | Provider Connect. Calls the poll, then writes the CLI auth file. |
| `src/backend/grok-bot/grok-bot-account.ts` | Sand account file, sign-in, refresh, sign-out. |
| `src/backend/grok-bot/grok-bot-gateway.ts` | `EnsureSandBox`, `listAgents`, `createAgent`. |
| `src/main/grok-bot-account-service.ts` | One in-memory session, the userData path, and the Electron cipher. |
| `packages/contracts/src/ipc-grok-bot.ts` | IPC result types. No decoder shared with the preload. |
| `src/main/ipc/grok-bot-handlers.ts` | IPC handlers. |
| `src/main/ipc/grok-bot-inputs.ts` | Decode the create payload in main. |
| `src/preload/grok-bot-decoding.ts` | Decode results in the preload. |
| `src/renderer/src/features/servers/ServerGrokBotPanel.tsx` | Desktop wiring. |
| `packages/ui/src/features/grok-bot/GrokBotAccountPanel.tsx` | Presentational panel. No `window.openbot`. |
| `scripts/cursor-login-poll-e2e.ts` | Poll returns tokens and writes no file. |
| `scripts/grok-bot-account-e2e.ts` | Account file, sign-out, refresh, CLI file untouched. |
| `scripts/grok-bot-gateway-e2e.ts` | List and create against a local gateway. |
| `src/backend/grok-bot/grok-bot-usage.ts` | Sand usage summary from the Grok Bot account token. |
| `packages/ui/src/features/account/account-usage-view.ts` | One extra rail row labeled "Grok Bot". |
| `scripts/grok-bot-usage-e2e.ts` | Summary mapping. The CLI reading stays separate. |

---

### Task 1: Poll that returns tokens

**Files:**
- Create: `src/backend/agent/cursor-login-poll.ts`
- Create: `scripts/cursor-login-poll-e2e.ts`
- Modify: `src/backend/agent/cursor-deep-login.ts`
- Test: `scripts/cursor-login-poll-e2e.ts`, `scripts/cursor-deep-login-e2e.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SAND_AUTH_REDIRECT_TARGET = "cli"`
  - `cursorLoginHandshake(websiteUrl: string): { uuid: string; verifier: string; loginUrl: string }`
  - `pollCursorLoginTokens(options: PollCursorLoginOptions): Effect.Effect<{ accessToken: string; refreshToken: string }, CliCodeLoginFailed>`
  - `PollCursorLoginOptions`: `{ apiBaseUrl: string; uuid: string; verifier: string; signal: AbortSignal; deadline: number; fetchImpl?: typeof fetch; now?: () => number; delay?: (attempt: number) => number }`
  - `pollDelayMs(attempt: number): number` exported for the account module.

The provider function `startCursorDeepLogin` keeps its signature and still writes `options.authFile ?? cursorAuthFile()`.

- [ ] **Step 1: Write the failing poll script**

Create `scripts/cursor-login-poll-e2e.ts`:

```ts
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
```

- [ ] **Step 2: Run the script and confirm it fails**

Run: `bun scripts/cursor-login-poll-e2e.ts`

Expected: FAIL. The module `../src/backend/agent/cursor-login-poll` does not exist.

- [ ] **Step 3: Add the poll module and point the provider at it**

Create `src/backend/agent/cursor-login-poll.ts`. Move the handshake, the poll loop, `pollDelayMs`, `abortableDelay`, and `cursorTokens` out of `cursor-deep-login.ts`. Do not import `cursor-usage`, `node:child_process`, or `node:fs`.

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result } from "effect";
import { CliCodeLoginFailed } from "./cli-code-login";

/** Desktop BotAI uses `cli` so the official Grok Bot `sand://` callback stays with Grok Bot. */
export const SAND_AUTH_REDIRECT_TARGET = "cli";
const MAX_POLL_ATTEMPTS = 150;

export function cursorLoginHandshake(websiteUrl: string): { uuid: string; verifier: string; loginUrl: string } {
  const verifier = Buffer.from(randomBytes(32)).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const uuid = randomUUID();
  const url = new URL("/loginDeepControl", websiteUrl);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("uuid", uuid);
  url.searchParams.set("mode", "login");
  url.searchParams.set("redirectTarget", SAND_AUTH_REDIRECT_TARGET);
  return { uuid, verifier, loginUrl: url.toString() };
}

export function pollDelayMs(attempt: number): number {
  return Math.min(1_000 * 1.2 ** attempt, 10_000);
}

export interface PollCursorLoginOptions {
  apiBaseUrl: string;
  uuid: string;
  verifier: string;
  signal: AbortSignal;
  deadline: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  delay?: (attempt: number) => number;
}

export const pollCursorLoginTokens = Effect.fn("CursorLoginPoll.poll")(function* (options: PollCursorLoginOptions) {
  registerSecretValue(options.verifier);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const endpoint = new URL("/auth/poll", options.apiBaseUrl);
  endpoint.searchParams.set("uuid", options.uuid);
  endpoint.searchParams.set("verifier", options.verifier);
  let failures = 0;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (options.signal.aborted) return yield* Effect.interrupt;
    if (now() >= options.deadline) {
      return yield* new CliCodeLoginFailed({ cause: new Error(sourceText("error.provider.acpSignInTimedOut")) });
    }
    const fetched = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          fetchImpl(endpoint, {
            headers: { "Content-Type": "application/json" },
            redirect: "manual",
            signal: options.signal,
          }),
        catch: () =>
          new CliCodeLoginFailed({
            cause: new Error(sourceText("error.provider.hostSignInEnded", { provider: "Cursor" })),
          }),
      }),
    );
    if (options.signal.aborted) return yield* Effect.interrupt;
    if (Result.isFailure(fetched)) return yield* fetched.failure;
    const response = fetched.success;
    if (response.status === 404) {
      failures = 0;
      yield* abortableDelay((options.delay ?? pollDelayMs)(attempt), options.signal);
      continue;
    }
    if (!response.ok) {
      failures += 1;
      if (failures >= 3) {
        return yield* new CliCodeLoginFailed({
          cause: new Error(sourceText("error.provider.hostSignInEnded", { provider: "Cursor" })),
        });
      }
      yield* abortableDelay((options.delay ?? pollDelayMs)(attempt), options.signal);
      continue;
    }
    const body = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: () => new CliCodeLoginFailed({ cause: new Error(sourceText("error.provider.codeLoginRefused")) }),
    });
    const tokens = cursorTokens(body);
    if (!tokens) {
      return yield* new CliCodeLoginFailed({ cause: new Error(sourceText("error.provider.codeLoginRefused")) });
    }
    registerSecretValue(tokens.accessToken);
    registerSecretValue(tokens.refreshToken);
    return tokens;
  }
  return yield* new CliCodeLoginFailed({ cause: new Error(sourceText("error.provider.acpSignInTimedOut")) });
});

function cursorTokens(value: unknown): { accessToken: string; refreshToken: string } | null {
  if (typeof value !== "object" || value === null || !("accessToken" in value) || !("refreshToken" in value))
    return null;
  const { accessToken, refreshToken } = value;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return null;
  return { accessToken, refreshToken };
}

function abortableDelay(delayMs: number, signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.interrupt);
      return Effect.void;
    }
    const timer = setTimeout(() => resume(Effect.void), delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resume(Effect.interrupt);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}
```

In `src/backend/agent/cursor-deep-login.ts`:

- Delete the local handshake, poll loop, `pollDelayMs`, `abortableDelay`, and `cursorTokens`.
- Import `cursorLoginHandshake` and `pollCursorLoginTokens` from `./cursor-login-poll`.
- Keep `writeCursorAuth` in this file. It is the provider write.
- `startCursorDeepLogin` builds the page with `cursorLoginHandshake(websiteUrl)` and sets `done` to:

```ts
const done = pollCursorLoginTokens({
  apiBaseUrl,
  uuid: login.uuid,
  verifier: login.verifier,
  signal: controller.signal,
  deadline,
  fetchImpl: options.fetchImpl,
  now: options.now,
  delay: options.delay,
}).pipe(
  Effect.tap((tokens) =>
    Effect.try({
      try: () => writeCursorAuth(options.authFile ?? cursorAuthFile(), tokens),
      catch: () =>
        new CliCodeLoginFailed({
          cause: new Error(sourceText("error.provider.hostSignInEnded", { provider: "Cursor" })),
        }),
    }),
  ),
  Effect.asVoid,
);
```

Keep `registerSecretValue(login.verifier)` before the poll if the handshake returns the verifier to this function. `pollCursorLoginTokens` also registers it. Both calls are safe.

Do not change `redirectTarget`. Do not change the keychain arguments in `writeCursorAuth`.

- [ ] **Step 4: Run both scripts**

Run: `bun scripts/cursor-login-poll-e2e.ts`

Expected: exit 0. `.openbot-build/cursor-login-poll-e2e/report.json` has `"passed": true`, `"redirectTarget": "cli"`, `"wroteFile": false`, `"tokens": true`.

Run: `bun scripts/cursor-deep-login-e2e.ts`

Expected: exit 0. The existing report still has `"passed": true` and `"link": true`. The provider still writes the auth file at mode `0600`.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write --max-diagnostics=none \
  src/backend/agent/cursor-login-poll.ts \
  src/backend/agent/cursor-deep-login.ts \
  scripts/cursor-login-poll-e2e.ts
git add src/backend/agent/cursor-login-poll.ts src/backend/agent/cursor-deep-login.ts scripts/cursor-login-poll-e2e.ts
git commit -m "refactor: return Cursor login tokens without writing the CLI file"
```

---

### Task 2: Sand account file, sign-in, and sign-out

**Files:**
- Create: `src/backend/grok-bot/grok-bot-account.ts`
- Create: `scripts/grok-bot-account-e2e.ts`
- Modify: `packages/i18n/src/messages/en/error/provider.ts`
- Test: `scripts/grok-bot-account-e2e.ts`

**Interfaces:**
- Consumes: `cursorLoginHandshake`, `pollCursorLoginTokens`, `pollDelayMs` from Task 1.
- Produces:
  - `GrokBotAccountFailed` (`Schema.TaggedError`, field `cause`)
  - `interface SecretCipher { encrypt(value: string): Buffer; decrypt(value: Buffer): string }`
  - `interface GrokBotAccountRecord { accessToken: string; refreshToken: string; gateway: GrokBotGatewaySession | null }`
  - `interface GrokBotGatewaySession { url: string; token: string; headers: Readonly<Record<string, string>> }`
  - `class GrokBotAccountStore`
  - `startGrokBotSignIn(options): Effect.Effect<{ verificationUrl: string; done: Effect.Effect<GrokBotAccountRecord, GrokBotAccountFailed> }, GrokBotAccountFailed>`
  - `publicGrokBotStatus(record: GrokBotAccountRecord | null): { signedIn: boolean }`
  - Do not add `refreshGrokBotAccessToken` in this task. Task 3 adds it on this class.

`GrokBotAccountStore` methods:

- `load(): Effect.Effect<GrokBotAccountRecord | null, GrokBotAccountFailed>`
- `save(record: GrokBotAccountRecord): Effect.Effect<void, GrokBotAccountFailed>`
- `clear(): Effect.Effect<void, GrokBotAccountFailed>`

- [ ] **Step 1: Add the English error keys**

In `packages/i18n/src/messages/en/error/provider.ts`, inside `defineMessages("error.provider", { ... })`, add:

```ts
"error.provider.grokBotSignInEnded": "The Grok Bot sign-in ended. Sign in again.",
"error.provider.grokBotNotSignedIn": "Sign in to Grok Bot first.",
"error.provider.grokBotSessionEnded": "The Grok Bot session ended. Sign in again.",
"error.provider.grokBotAgentRejected": "Grok Bot did not accept this agent.",
"error.provider.grokBotNameRequired": "Enter a name.",
```

Do not add the keys to other locales. A missing translation shows the English text.

- [ ] **Step 2: Write the failing account script**

Create `scripts/grok-bot-account-e2e.ts`. It must:

1. Start a loopback `GET /auth/poll` that returns `{ accessToken: "grok-access-e2e", refreshToken: "grok-refresh-e2e" }` on the second poll and 404 on the first.
2. Write a CLI stand-in file `cli-auth.json` with `{ "accessToken": "cli-access", "refreshToken": "cli-refresh" }` **before** the Grok Bot sign-in.
3. Call `startGrokBotSignIn` with `authFile` set to `grok-account.json`, `websiteUrl: "https://cursor.com"`, `apiBaseUrl` set to the loopback origin, `delay: () => 0`, `timeoutMs: 5000`, and a test cipher:

```ts
const cipher = {
  encrypt: (value: string) => Buffer.from(value, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8"),
};
```

4. Assert the verification URL has `redirectTarget=cli` and does not contain the verifier.
5. Await `done`.
6. Assert `cli-auth.json` is byte-for-byte the original CLI JSON.
7. Assert `grok-account.json` exists, mode `0600`, and its plaintext (after the test cipher) contains `grok-access-e2e` and does not contain `cli-access`.
8. Assert `publicGrokBotStatus(record).signedIn === true` and `JSON.stringify(publicGrokBotStatus(record))` does not contain `grok-access-e2e`.
9. Import `redactText` from `@openbot/logging`. Assert `redactText("token grok-access-e2e")` is `"token [redacted]"` after `done` returns.
10. Call `store.clear()`. Assert `load()` returns `null` and the CLI file is still unchanged.
11. Write `.openbot-build/grok-bot-account-e2e/report.json`:

```json
{
  "passed": true,
  "redirectTarget": "cli",
  "cliUntouched": true,
  "stored": true,
  "statusHidesToken": true,
  "redacted": true,
  "signedOut": true
}
```

Exit 1 when `passed` is false. Use the same listen helper shape as `scripts/cursor-deep-login-e2e.ts`.

- [ ] **Step 3: Run the script and confirm it fails**

Run: `bun scripts/grok-bot-account-e2e.ts`

Expected: FAIL. `src/backend/grok-bot/grok-bot-account.ts` does not exist.

- [ ] **Step 4: Implement the store and sign-in**

Create `src/backend/grok-bot/grok-bot-account.ts`.

Rules for this file:

- Do not import `node:child_process`.
- Do not call `writeCursorAuth`, `cursorAuthFile`, or `/usr/bin/security`.
- On-disk JSON is `{ version: 1, payload: "<base64>" }`. `payload` is `cipher.encrypt(JSON.stringify(record)).toString("base64")`.
- Write with `writeJsonFileAtomically` from `src/backend/atomic-json-file.ts` and `{ createDirectory: true }`. That helper already uses mode `0600`.
- A missing file loads as `null`. A file that does not decode loads as `GrokBotAccountFailed` with `sourceText("error.provider.grokBotSignInEnded")`.
- `clear` deletes the file. A missing file is success (`rm` with `force: true`).
- `registerSecretValue` on `accessToken`, `refreshToken`, and `gateway.token` inside `save` and `load`.
- `startGrokBotSignIn` calls `cursorLoginHandshake` and `pollCursorLoginTokens`. On success it `save`s `{ accessToken, refreshToken, gateway: null }` and returns that record. It does not open a browser. The renderer opens the URL.
- Map `CliCodeLoginFailed` to `GrokBotAccountFailed` whose `cause` is `new Error(sourceText("error.provider.grokBotSignInEnded"))`. Do not copy the provider error text into a new sentence that includes a token.
- `publicGrokBotStatus` returns `{ signedIn: record !== null }`.

```ts
export function publicGrokBotStatus(record: GrokBotAccountRecord | null): { signedIn: boolean } {
  return { signedIn: record !== null };
}
```

`startGrokBotSignIn` options:

```ts
export interface GrokBotSignInOptions {
  timeoutMs: number;
  authFile: string;
  cipher: SecretCipher;
  websiteUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  delay?: (attempt: number) => number;
  signal: AbortSignal;
}
```

Default website `https://cursor.com`. Default API `https://api2.cursor.sh`. Honor `CURSOR_WEBSITE_URL` and `CURSOR_API_BASE_URL` the same way `startCursorDeepLogin` does, then strip a trailing slash.

The poll deadline is `(now ?? Date.now)() + timeoutMs`. Pass `options.signal` through. The caller aborts it on cancel.

- [ ] **Step 5: Run the account script**

Run: `bun scripts/grok-bot-account-e2e.ts`

Expected: exit 0. The report fields in Step 2 are all true. `redirectTarget` is `cli`.

- [ ] **Step 6: Commit**

```bash
bunx biome check --write --max-diagnostics=none \
  src/backend/grok-bot/grok-bot-account.ts \
  scripts/grok-bot-account-e2e.ts \
  packages/i18n/src/messages/en/error/provider.ts
git add src/backend/grok-bot/grok-bot-account.ts scripts/grok-bot-account-e2e.ts packages/i18n/src/messages/en/error/provider.ts
git commit -m "feat: store a Grok Bot account apart from the Cursor CLI sign-in"
```

---

### Task 3: Refresh the access token and sign out when Cursor says so

**Files:**
- Modify: `src/backend/grok-bot/grok-bot-account.ts`
- Modify: `scripts/grok-bot-account-e2e.ts`
- Test: `scripts/grok-bot-account-e2e.ts`

**Interfaces:**
- Consumes: `GrokBotAccountStore` and `GrokBotAccountRecord` from Task 2.
- Produces:
  - `accessTokenNeedsRefresh(accessToken: string, now: number): boolean`
  - `refreshGrokBotAccessToken(options): Effect.Effect<GrokBotAccountRecord | null, GrokBotAccountFailed>`
  - `null` means Cursor set `shouldLogout` or returned an empty access token. The store is cleared.
  - A new refresh token in the response replaces the saved one. A missing refresh token keeps the old one.

Refresh request, copied from Cursor's published client grant (this client id is public; it is not an OpenBot secret):

```http
POST {apiBaseUrl}/oauth/token
Content-Type: application/json

{"grant_type":"refresh_token","client_id":"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB","refresh_token":"<refresh>"}
```

Read `access_token`, optional `refresh_token`, and `should_logout` from the JSON. Do not log the body.

`accessTokenNeedsRefresh` is true when the JWT `exp` (seconds) is less than 5 minutes ahead of `now`. A token that is not a three-part JWT returns false. Refresh still runs when `EnsureSandBox` returns 401 (Task 4).

- [ ] **Step 1: Extend the e2e before the implementation**

In `scripts/grok-bot-account-e2e.ts`, after the sign-out assertions, add a second case that does not delete the report from the first case. Use a new temp directory.

1. Save a record whose access token is a JWT with `exp` 60 seconds ahead of `Date.now()`. Build it with `Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url")` between two `e30` segments: `e30.${payload}.e30`. The fixture refresh token is `grok-refresh-e2e`.
2. Assert `accessTokenNeedsRefresh(token, Date.now()) === true`.
3. Serve `POST /oauth/token` with `{ "access_token": "grok-access-e2e-2", "refresh_token": "grok-refresh-e2e-2", "should_logout": false }`.
4. Call `refreshGrokBotAccessToken`. Assert the saved access token is `grok-access-e2e-2` and the CLI file from Step 2 of Task 2 is not opened (pass a different `authFile`).
5. Serve a second refresh with `{ "access_token": "", "should_logout": true }`. Assert the result is `null` and `load()` is `null`.
6. Add `"refreshed": true` and `"loggedOut": true` to the report. Keep the Task 2 fields.

- [ ] **Step 2: Run the script and confirm the new assertions fail**

Run: `bun scripts/grok-bot-account-e2e.ts`

Expected: FAIL because `refreshGrokBotAccessToken` is not exported.

- [ ] **Step 3: Implement refresh**

Add the client id as a constant in `grok-bot-account.ts`:

```ts
/** Cursor's published public client id for the refresh_token grant. Not an OpenBot secret. */
const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
```

`refreshGrokBotAccessToken` reads the store. No record returns `null` without a request. It `POST`s the body above with `redirect: "manual"`. HTTP outside 200–299 is `GrokBotAccountFailed` with `sourceText("error.provider.grokBotSessionEnded")`. `should_logout: true` or an empty `access_token` calls `clear()` and returns `null`. Otherwise `save` the new tokens and keep `gateway` unchanged. `registerSecretValue` on both new tokens.

Do not write `cursorAuthFile()`.

- [ ] **Step 4: Run the account script**

Run: `bun scripts/grok-bot-account-e2e.ts`

Expected: exit 0. Report includes `"refreshed": true` and `"loggedOut": true`.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write --max-diagnostics=none src/backend/grok-bot/grok-bot-account.ts scripts/grok-bot-account-e2e.ts
git add src/backend/grok-bot/grok-bot-account.ts scripts/grok-bot-account-e2e.ts
git commit -m "feat: refresh the Grok Bot access token without touching the CLI sign-in"
```

---

### Task 4: EnsureSandBox, listAgents, and createAgent

**Files:**
- Create: `src/backend/grok-bot/grok-bot-gateway.ts`
- Create: `scripts/grok-bot-gateway-e2e.ts`
- Modify: `src/backend/grok-bot/grok-bot-account.ts` (save the gateway on the record)
- Test: `scripts/grok-bot-gateway-e2e.ts`

**Interfaces:**
- Consumes: `GrokBotAccountStore`, `GrokBotAccountRecord`, `GrokBotGatewaySession`, `refreshGrokBotAccessToken`, `GrokBotAccountFailed`.
- Produces:
  - `interface GrokBotAgentSummary { id: string; name: string; title: string; description: string; hidden: boolean; room: boolean }`
  - `interface CreateGrokBotAgentInput { name: string; description: string }`
  - `listGrokBotAgents(store, options): Effect.Effect<readonly GrokBotAgentSummary[], GrokBotAccountFailed>`
  - `createGrokBotAgent(store, input, options): Effect.Effect<GrokBotAgentSummary, GrokBotAccountFailed>`
  - `options` is `{ fetchImpl?: typeof fetch; apiBaseUrl?: string; now?: () => number; allowLoopback?: boolean }`

Gateway calls:

```http
POST {gatewayUrl}/api/listAgents
Authorization: Bearer <gatewayToken>
Content-Type: application/json

{}
```

```http
POST {gatewayUrl}/api/createAgent
Authorization: Bearer <gatewayToken>
Content-Type: application/json

{"name":"<trimmed>","description":"<text>","title":"","avatarShape":"","avatarColor":"","origin":"user"}
```

`origin` is always `"user"`. Empty avatar fields mean the server default (`grokbot_api` 1.2.0). Do not send a shape or color in this plan.

EnsureSandBox:

```http
POST {apiBaseUrl}/aiserver.v1.GrokBotService/EnsureSandBox
Authorization: Bearer <accessToken>
Content-Type: application/json
connect-protocol-version: 1
x-cursor-client-type: sand
x-cursor-client-version: 0.70.2
x-sand-box-namespace: prod

{}
```

`0.70.2` is `grokbot_api` 1.2.0 `DEFAULT_CLIENT_VERSION`. Put it in `GROK_BOT_CURSOR_CLIENT_VERSION`. The header `x-cursor-client-type: sand` does not register a protocol.

Read `gatewayUrl` or `gateway_url`, and `gatewayToken` or `gateway_token`. Extra headers: `gatewayHeaders` or `gateway_headers`. When those are absent, read `anyrunNetworkToken` or `anyrun_network_token` or `networkToken` and store it as header `x-anyrun-network-token`.

Accept a gateway URL only when all of these hold:

- `https`
- no username or password
- host is `cursorvm.com` or ends with `.cursorvm.com`
- `allowLoopback` is true **and** the host is `127.0.0.1` (tests only)

The production service passes `allowLoopback: false`. Reject every other host, including `api.cursor.com`. `redirect: "manual"`. A 3xx is a failure. Cap the body at 2 MiB (`response.text()` then check `length`). Timeout 30 s with `AbortSignal.timeout(30_000)`.

Session reuse:

- When `record.gateway` is set, call the gateway first.
- HTTP 401 or 417: call `EnsureSandBox` once, `save` the new gateway, retry the gateway call once. Do not loop.
- `EnsureSandBox` HTTP 401: call `refreshGrokBotAccessToken` once. When it returns `null`, fail with `error.provider.grokBotSessionEnded`. Otherwise retry `EnsureSandBox` once.
- No saved record: fail with `error.provider.grokBotNotSignedIn`.
- Blank trimmed name, or name longer than 80, or description longer than 2000: fail with `error.provider.grokBotNameRequired` or `error.provider.grokBotAgentRejected` **before** `fetch`. Description may be `""`.

Parse list JSON as an array, or `{ agents: [...] }`, or `{ agent: {...} }`. Skip a record with no `id` and no `agentId`. `room` is `isGroup` when that boolean is present, otherwise true when `memberIds` or `memberAgentIds` is a non-empty array. `hidden` is `isHiddenFromSidebar` or `hiddenFromSidebar`, default false. `name`, `title`, and `description` default to `""`.

Parse create JSON with the same record parser on `{ agent }` or the object itself. No id is `error.provider.grokBotAgentRejected`.

- [ ] **Step 1: Write the failing gateway script**

`scripts/grok-bot-gateway-e2e.ts` uses two loopback servers.

Backend server:

- `POST /aiserver.v1.GrokBotService/EnsureSandBox` checks `authorization: Bearer grok-access-e2e`, `x-cursor-client-type: sand`, and `connect-protocol-version: 1`.
- First call returns 401. Second call returns `{ "gatewayUrl": "http://127.0.0.1:<gatewayPort>", "gatewayToken": "gw-e2e", "anyrunNetworkToken": "net-e2e" }`.

Gateway server:

- `POST /api/listAgents` with `Authorization: Bearer gw-e2e` and `x-anyrun-network-token: net-e2e` returns `{ "agents": [ { "id": "a1", "name": "Research", "isGroup": false }, { "name": "skip" }, { "agentId": "g1", "title": "Desk", "memberIds": ["a1"], "hiddenFromSidebar": true } ] }`.
- `POST /api/createAgent` returns `{ "agent": { "id": "a2", "name": "Notes", "description": "Short" } }`. Assert the request body `origin` is `user` and `avatarShape` is `""`.

Seed the store with the test cipher and `{ accessToken: "grok-access-e2e", refreshToken: "grok-refresh-e2e", gateway: null }`. Pass `allowLoopback: true`.

Assert:

- `listGrokBotAgents` returns two rows: `a1` with `room: false`, `hidden: false`; `g1` with `room: true`, `hidden: true`. The row with no id is absent.
- After the 401, the saved gateway URL is the loopback gateway origin and the gateway token is `gw-e2e`.
- `createGrokBotAgent(store, { name: " Notes ", description: "Short" }, options)` returns `{ id: "a2", name: "Notes", description: "Short", title: "", hidden: false, room: false }`.
- `createGrokBotAgent(store, { name: "  ", description: "" }, options)` fails and the gateway create count stays 1.
- A second list does not call `EnsureSandBox` again (count stays 2: the 401 and the success).

Write `.openbot-build/grok-bot-gateway-e2e/report.json` with `{ "passed": true, "listed": 2, "created": true, "rejectedBlank": true, "sandboxCalls": 2 }`.

Also assert the request URL for EnsureSandBox contains `GrokBotService/EnsureSandBox` and the script never requested a path that contains `createAgentFromTemplate`.

- [ ] **Step 2: Run the script and confirm it fails**

Run: `bun scripts/grok-bot-gateway-e2e.ts`

Expected: FAIL. `grok-bot-gateway.ts` does not exist.

- [ ] **Step 3: Implement the gateway client**

Put the HTTP and parsers in `src/backend/grok-bot/grok-bot-gateway.ts`. Keep the account file free of gateway paths. Call `refreshGrokBotAccessToken` from the account module when EnsureSandBox returns 401.

Register `gatewayToken` and `anyrun` header values with `registerSecretValue` before saving.

- [ ] **Step 4: Run the gateway script**

Run: `bun scripts/grok-bot-gateway-e2e.ts`

Expected: exit 0. Report matches Step 1.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write --max-diagnostics=none src/backend/grok-bot/grok-bot-gateway.ts src/backend/grok-bot/grok-bot-account.ts scripts/grok-bot-gateway-e2e.ts
git add src/backend/grok-bot/grok-bot-gateway.ts src/backend/grok-bot/grok-bot-account.ts scripts/grok-bot-gateway-e2e.ts
git commit -m "feat: list and create Grok Bot agents with the sand account"
```

---

### Task 5: IPC group on this computer only

**Files:**
- Create: `packages/contracts/src/ipc-grok-bot.ts`
- Create: `src/main/grok-bot-account-service.ts`
- Create: `src/main/ipc/grok-bot-handlers.ts`
- Create: `src/main/ipc/grok-bot-inputs.ts`
- Create: `src/preload/grok-bot-decoding.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ipc-endpoints.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/preview/mock-openbot.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/application-services.ts`
- Test: `bun run typecheck:node`, then `bun run typecheck:renderer`, then `bun run test:desktop -- src/main/ipc-channel-coverage.test.ts`

**Interfaces:**
- Consumes: `GrokBotAccountStore`, `startGrokBotSignIn`, `publicGrokBotStatus`, `listGrokBotAgents`, `createGrokBotAgent`, `refreshGrokBotAccessToken`.
- Produces: `window.openbot.grokBot` with:
  - `getStatus(): Promise<{ signedIn: boolean }>`
  - `startSignIn(): Promise<{ verificationUrl: string }>`
  - `cancelSignIn(): Promise<void>`
  - `signOut(): Promise<{ signedIn: boolean }>`
  - `listAgents(): Promise<readonly GrokBotAgentSummary[]>`
  - `createAgent(input: { name: string; description: string }): Promise<GrokBotAgentSummary>`
  - `onAccount(listener: (event: GrokBotAccountEvent) => void): () => void`
- `GrokBotAccountEvent` is `{ phase: "signed-in" } | { phase: "signed-out" } | { phase: "failed"; message: string }`.
- `message` is `sourceText` English. It never contains a token.

No `serverId`. No Team API route. `IPC_GROUP_PATHS.grokBot` is `"grokBot"`.

- [ ] **Step 1: Declare the group**

Add `packages/contracts/src/ipc-grok-bot.ts` with the types above and:

```ts
export interface GrokBotSignInStart {
  readonly verificationUrl: string;
}
```

Export it from `packages/contracts/src/ipc.ts`:

```ts
export * from "./ipc-grok-bot";
```

In `packages/contracts/src/ipc-endpoints.ts`, import the types and add this group beside `agentImport` (before the `as const` closes). `request` is `request<Payload, Result>()`. A call with no payload uses `undefined` as the first type argument:

```ts
grokBot: {
  getStatus: request<undefined, { signedIn: boolean }>()("grok-bot:get-status"),
  startSignIn: request<undefined, GrokBotSignInStart>()("grok-bot:start-sign-in"),
  cancelSignIn: request<undefined, void>()("grok-bot:cancel-sign-in"),
  signOut: request<undefined, { signedIn: boolean }>()("grok-bot:sign-out"),
  listAgents: request<undefined, readonly GrokBotAgentSummary[]>()("grok-bot:list-agents"),
  createAgent: request<CreateGrokBotAgentInput, GrokBotAgentSummary>()("grok-bot:create-agent"),
  account: event<GrokBotAccountEvent>()("grok-bot:account"),
},
```

Add `grokBot: "grokBot"` to `IPC_GROUP_PATHS`.

- [ ] **Step 2: Run the node typecheck and confirm it names the missing registrar**

Run: `bun run typecheck:node`

Expected: FAIL. `registerIpcGroups` in `src/main/index.ts` reports a missing `grokBot` group (`TS2741`).

- [ ] **Step 3: Add the service, handlers, preload, and mock**

`src/main/grok-bot-account-service.ts` owns:

- `path`: `join(app.getPath("userData"), "openbot-grok-bot-account-v1.json")` passed in by `createApplicationServices`. The service file must not import Electron if `application-services.ts` passes the path and cipher. Prefer that split: the service imports only `effect` and the backend modules.
- `cipher`: the object from `safeStorageCipher("error.app.secretStorageUnavailable")` in `application-services.ts`.
- One `AbortController` for the active poll. `start` aborts the previous poll, then calls `startGrokBotSignIn`. It does not await `done` on the IPC call. It starts `done` with `Effect.runPromise`, then `sendToRenderer(getMainWindow(), IPC_ENDPOINTS.grokBot.account, { phase: "signed-in" })`. On failure it sends `{ phase: "failed", message }` where `message` is the `Error` message from the cause, or `sourceText("error.provider.grokBotSignInEnded")` when the cause is not an `Error`.
- `cancel` aborts the controller and does not clear a saved account.
- `signOut` aborts, calls `store.clear()`, and sends `{ phase: "signed-out" }`.
- `list` and `create` call the gateway functions with `allowLoopback: false`. Pass `apiBaseUrl` only when `process.env.CURSOR_API_BASE_URL` is `https://api2.cursor.sh` after the trailing slash is removed. Otherwise omit it. The gateway default is `https://api2.cursor.sh`. Do not read a gateway URL from the renderer.
- `dispose` aborts the poll.

Wire it in `createApplicationServices`:

```ts
teardown.push(26, "the Grok Bot account poll", () => grokBotAccount.dispose());
```

Ordinal 26 is before `providerAccountsHost` (27) in `TEARDOWN_ORDER`. Add `grokBotAccount: 26` to that object and use `TEARDOWN_ORDER.grokBotAccount`. Do not reuse `26` for another step.

`src/main/ipc/grok-bot-handlers.ts` follows `agent-import-handlers.ts`: a `GrokBotIpcDependencies` interface, `grokBotIpcHandlers(...) : Pick<IpcGroupHandlers, "grokBot">`. Use `handler` for the no-payload methods and `payloadHandler(parseCreateGrokBotAgentInput, ...)` for create. Run effects with `runCauseEffect` from `src/backend/effect-boundary.ts`.

`src/main/ipc/grok-bot-inputs.ts`:

```ts
import type { CreateGrokBotAgentInput } from "@openbot/contracts/ipc";
import { isObject, requireString } from "./validation";

export function parseCreateGrokBotAgentInput(value: unknown): CreateGrokBotAgentInput {
  if (!isObject(value)) throw new Error("Invalid Grok Bot agent.");
  return {
    name: requireString(value.name, "name", 80),
    description: typeof value.description === "string" ? value.description.slice(0, 2000) : "",
  };
}
```

`requireString` already trims and rejects an empty name. A programming error stays English (`src/main/AGENTS.md`).

`src/preload/grok-bot-decoding.ts` decodes each result. Reject a payload that contains `accessToken`, `refreshToken`, `gatewayToken`, or `verifier` by throwing `new Error("Invalid Grok Bot response.")` before returning it. Decode `verificationUrl` only when it is `https:` and the host is `cursor.com`. Decode agents with the same field rules as Task 4. Do not import the main input parser.

In `src/preload/index.ts` add:

```ts
grokBot: bridgeGroup(IPC_ENDPOINTS.grokBot, {
  getStatus: decodeGrokBotStatus,
  startSignIn: decodeGrokBotSignInStart,
  cancelSignIn: decodeVoid,
  signOut: decodeGrokBotStatus,
  listAgents: decodeGrokBotAgents,
  createAgent: decodeGrokBotAgent,
  account: decodeGrokBotAccountEvent,
}),
```

`decodeVoid` is already imported from `./app-decoding`.

In `src/renderer/src/preview/mock-openbot.ts` add `grokBot` next to `routineFeed`. The mock holds no token. `getStatus` returns `{ signedIn: false }`. `startSignIn` returns `{ verificationUrl: "https://cursor.com/loginDeepControl?mode=login&redirectTarget=cli" }`. `listAgents` returns `[]`. `createAgent` returns `{ id: "preview-agent", name: input.name, title: "", description: input.description, hidden: false, room: false }`. `onAccount` returns an unsubscribe function. `signOut` returns `{ signedIn: false }`.

Spread `grokBotIpcHandlers({ grokBotAccount, getMainWindow: getDialogParent })` inside `registerIpcGroups` in `src/main/index.ts`.

- [ ] **Step 4: Run the typechecks and the coverage test**

Run: `bun run typecheck:node`

Expected: exit 0.

Run: `bun run typecheck:renderer`

Expected: exit 0. If it names a missing mock method, add that method and run this command again.

Run: `bun run test:desktop -- src/main/ipc-channel-coverage.test.ts`

Expected: exit 0. The new channels are invoked by the preload bridge.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write --max-diagnostics=none \
  packages/contracts/src/ipc-grok-bot.ts \
  packages/contracts/src/ipc.ts \
  packages/contracts/src/ipc-endpoints.ts \
  src/main/grok-bot-account-service.ts \
  src/main/ipc/grok-bot-handlers.ts \
  src/main/ipc/grok-bot-inputs.ts \
  src/preload/grok-bot-decoding.ts \
  src/preload/index.ts \
  src/renderer/src/preview/mock-openbot.ts \
  src/main/index.ts \
  src/main/application-services.ts
git add packages/contracts/src/ipc-grok-bot.ts packages/contracts/src/ipc.ts packages/contracts/src/ipc-endpoints.ts \
  src/main/grok-bot-account-service.ts src/main/ipc/grok-bot-handlers.ts src/main/ipc/grok-bot-inputs.ts \
  src/preload/grok-bot-decoding.ts src/preload/index.ts src/renderer/src/preview/mock-openbot.ts \
  src/main/index.ts src/main/application-services.ts
git commit -m "feat: add a local IPC group for the Grok Bot account"
```

`src/main/ipc/index.ts` does not exist. Do not create it. Handlers are spread from `src/main/index.ts`.

---

### Task 6: Settings panel next to Import

**Files:**
- Create: `packages/ui/src/features/grok-bot/GrokBotAccountPanel.tsx`
- Modify: `packages/ui/package.json` (`exports`)
- Create: `src/renderer/src/features/servers/ServerGrokBotPanel.tsx`
- Create: `src/renderer/stories/GrokBotAccountPanel.stories.tsx`
- Modify: `src/renderer/src/features/servers/ServerSettingsModal.tsx`
- Modify: `src/renderer/src/WorkspaceOverlays.tsx`
- Modify: `packages/i18n/src/messages/en/server.ts`
- Modify: `docs/architecture/agents.md`
- Test: `bun run typecheck:renderer` after the UI compiles. Do not add a `play` function. Do not add `data-testid`.

**Interfaces:**
- Consumes: `OpenBotDesktopApi["grokBot"]` from `@openbot/contracts/ipc`.
- Produces: the presentational props:

```ts
export interface GrokBotAccountPanelProps {
  signedIn: boolean;
  agents: readonly { id: string; name: string; title: string; description: string; hidden: boolean; room: boolean }[];
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onRefresh: () => void;
  onCreate: (input: { name: string; description: string }) => void;
}
```

The panel shows agents where `hidden` is false. A `room` row shows `t("server.settings.grokBotGroup")` beside the name. It does not call `window.openbot`.

- [ ] **Step 1: Add the English UI keys**

In `packages/i18n/src/messages/en/server.ts`, after `server.settings.importDescription`, add:

```ts
"server.settings.grokBotTitle": "Grok Bot",
"server.settings.grokBotDescription": "Sign in to Grok Bot and see the agents on that account. Import still reads a zip file.",
"server.settings.grokBotSignIn": "Sign in",
"server.settings.grokBotSignOut": "Sign out",
"server.settings.grokBotRefresh": "Refresh",
"server.settings.grokBotEmpty": "No agents on this Grok Bot account yet.",
"server.settings.grokBotName": "Name",
"server.settings.grokBotInstructions": "Instructions",
"server.settings.grokBotCreate": "Create agent",
"server.settings.grokBotGroup": "Group",
"server.settings.grokBotImportHint": "A zip import still lives under Import. It copies agents onto this server. This list is the live Grok Bot account.",
```

- [ ] **Step 2: Add the presentational panel and a story**

`packages/ui/src/features/grok-bot/GrokBotAccountPanel.tsx` uses `SettingsSection`, `Button`, `Input`, `Item`, `ItemGroup`, `ItemContent`, `ItemTitle`, `ItemDescription`, and `ItemActions` from `@openbot/ui`, and `useText` from `@openbot/ui/text`. Follow `packages/ui/src/features/settings/BackgroundProcessesSection.tsx` for the row classes (`settings-modal-card`, `settings-modal-row`).

Behavior:

- Signed out: one Sign in button. No form.
- Signed in: Sign out, Refresh, the visible agent rows, and a form with Name and Instructions. Create calls `onCreate` with the trimmed name and the description. The component does not validate past an empty submit: it leaves the name field unchanged when `name.trim()` is empty.
- `error` renders as `ItemDescription` text. The parent passes already translated text.
- Do not add a stylesheet. Use the existing settings classes.

Export in `packages/ui/package.json`:

```json
"./features/grok-bot/GrokBotAccountPanel": "./src/features/grok-bot/GrokBotAccountPanel.tsx"
```

Story `src/renderer/stories/GrokBotAccountPanel.stories.tsx` shows two stories, `SignedOut` and `SignedIn`, with static props. `SignedIn` includes one visible agent and one hidden agent so the hidden row is absent. No `play` function.

- [ ] **Step 3: Wire the desktop panel**

`src/renderer/src/features/servers/ServerGrokBotPanel.tsx`:

```ts
export interface ServerGrokBotOptions {
  api: OpenBotDesktopApi["grokBot"];
  openUrl: (url: string) => Promise<void>;
}
```

On mount, call `api.getStatus()` and, when `signedIn`, `api.listAgents()`. Subscribe to `api.onAccount`. `signed-in` reloads the list. `signed-out` clears it. `failed` sets the error from `errorMessage`. Sign in calls `api.startSignIn()` and then `openUrl(verificationUrl)`. Sign out calls `api.signOut()`. Refresh calls `api.listAgents()`. Create calls `api.createAgent` and appends the result. Use `createStore` from `solid-js` for `{ signedIn, agents, error }`. Read callbacks inside the `createEffect` compute function, not inside the effect callback (`src/renderer/AGENTS.md`).

In `ServerSettingsModal.tsx`:

- Add `"grok-bot"` to `ServerSettingsSection` and to `sections`, with the title and description keys above.
- Add optional prop `grokBot?: ServerGrokBotOptions`.
- Nav trigger after the Import trigger, inside `<Show when={props.grokBot}>`, icon `Bot` from `@openbot/ui`.
- Add `"grok-bot"` to the `onChange` union.
- Tab content renders `ServerGrokBotPanel` only when `props.grokBot` is set. Key it by `props.server.id`.

In `src/renderer/src/WorkspaceOverlays.tsx`, pass `grokBot` only when `server().kind === "local"`:

```tsx
grokBot={
  server().kind === "local"
    ? { api: appPort().grokBot, openUrl: (url) => appPort().openUrl(url) }
    : undefined
}
```

`openUrl` is `request<string, void>()("app:open-url")`. `openHttpLink` in `src/main/message-link-relay.ts` accepts `https:` and rejects every other scheme, including `sand:`. `openExternal` is a fixed destination union. Do not use it for this page. Do not call `shell.openExternal` from the renderer.

Do not pass `grokBot` in `src/renderer/src/features/web-client/WebWorkspace.tsx`.

- [ ] **Step 4: Document the three paths**

Append this section at the end of `docs/architecture/agents.md`:

```markdown
## Grok Bot account

Server settings on this computer has a Grok Bot section. It signs in with the same
`loginDeepControl` poll as the Cursor provider (`redirectTarget=cli`) and stores the tokens in
`openbot-grok-bot-account-v1.json` under user data. It does not write the Cursor CLI auth file.

The section lists and creates agents on the Grok Bot gateway (`EnsureSandBox`, then
`listAgents` and `createAgent`). Those agents stay on the Grok Bot account. Import still reads a
Grok Bot zip into local OpenBot agents. Connect on the Cursor provider still writes the CLI
sign-in. The web client and a joined server do not show this section.
```

- [ ] **Step 5: Typecheck the renderer**

Run: `bun run typecheck:renderer`

Expected: exit 0.

Run: `bunx biome check --write --max-diagnostics=none packages/ui/src/features/grok-bot/GrokBotAccountPanel.tsx packages/ui/package.json src/renderer/src/features/servers/ServerGrokBotPanel.tsx src/renderer/src/features/servers/ServerSettingsModal.tsx src/renderer/src/WorkspaceOverlays.tsx src/renderer/stories/GrokBotAccountPanel.stories.tsx packages/i18n/src/messages/en/server.ts docs/architecture/agents.md`

Expected: exit 0. Fix only the files this task changed.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/features/grok-bot/GrokBotAccountPanel.tsx packages/ui/package.json \
  src/renderer/src/features/servers/ServerGrokBotPanel.tsx \
  src/renderer/src/features/servers/ServerSettingsModal.tsx \
  src/renderer/src/WorkspaceOverlays.tsx \
  src/renderer/stories/GrokBotAccountPanel.stories.tsx \
  packages/i18n/src/messages/en/server.ts \
  docs/architecture/agents.md
git commit -m "feat: show the Grok Bot account in Server settings"
```

### Task 7: Grok Bot usage on the provider usage rail

**Files:**
- Create: `src/backend/grok-bot/grok-bot-usage.ts`
- Create: `scripts/grok-bot-usage-e2e.ts`
- Modify: `packages/contracts/src/ipc-grok-bot.ts`
- Modify: `packages/contracts/src/ipc-endpoints.ts`
- Modify: `src/main/ipc/grok-bot-handlers.ts`
- Modify: `src/main/grok-bot-account-service.ts`
- Modify: `src/preload/grok-bot-decoding.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/preview/mock-openbot.ts`
- Modify: `packages/ui/src/features/account/account-usage-view.ts`
- Modify: `packages/ui/src/features/account/AccountUsageDetails.tsx`
- Modify: `packages/ui/src/features/window/PageRail.tsx`
- Modify: `src/renderer/src/features/usage/plan-limit-rows.ts`
- Modify: `src/renderer/src/features/servers/ServerGrokBotPanel.tsx`
- Modify: `packages/ui/src/features/grok-bot/GrokBotAccountPanel.tsx`
- Modify: `packages/i18n/src/messages/en/account.ts`
- Modify: `docs/architecture/agents.md`
- Test: `scripts/grok-bot-usage-e2e.ts`, then `bun run typecheck:node`, then `bun run typecheck:renderer`, then `bun run test:desktop -- src/main/ipc-channel-coverage.test.ts`

**Interfaces:**
- Consumes: `GrokBotAccountStore`, `refreshGrokBotAccessToken`, and `GrokBotAccountFailed` from Tasks 2 and 3. The IPC group from Task 5. The settings panel from Task 6. `AccountUsageProviderRow` and `AccountUsageWindowRow` from `packages/ui/src/features/account/account-usage-view.ts`. `usePlanLimitRows` in `src/renderer/src/features/usage/plan-limit-rows.ts`. `AccountUsageDetails` and `UsageRings` in `packages/ui/src/features/window/PageRail.tsx`.
- Produces:

```ts
export interface GrokBotUsageSummary {
  /** 0–100. Null when neither percent field is present. */
  readonly includedUsedPercent: number | null;
  /** Unix seconds from `nextResetTimestampUtc`. Null when that field is absent or not a date. */
  readonly includedResetsAt: number | null;
  readonly hasAvailableUsage: boolean;
  /** True when GetTeams has a non-empty `teams` array, or GetSandUsageStatus has `usesPooledEnterpriseAllowance: true`. */
  readonly enterprise: boolean;
  /** True when `sandTrialExpiresAt` is a date after `now`. */
  readonly trialActive: boolean;
  /** True only when GetSandTrialClaimStatus JSON has `claimable: true`. */
  readonly trialClaim: boolean;
  /** True when `upgradeRecommendation` is a non-empty string. The string itself is dropped. */
  readonly changeLimit: boolean;
  /** Dollars from cents. Null when `individualLimit` is missing or 0. */
  readonly onDemand: { readonly usedUsd: number; readonly limitUsd: number; readonly usedPercent: number; readonly resetsAt: number | null } | null;
}

export const GROK_BOT_USAGE_ACCOUNT_ID = "grok-bot";

export function grokBotUsageRow(summary: GrokBotUsageSummary, text: UsageText): AccountUsageProviderRow | null
```

`readGrokBotUsageSummary(store, options)` returns `GrokBotUsageSummary | null`. `options` is `{ fetchImpl?: typeof fetch; apiBaseUrl?: string; now?: () => number }`. The default `apiBaseUrl` is `https://api2.cursor.sh`. A caller may pass `http://127.0.0.1` with a port for the e2e. Any other non-https base is `GrokBotAccountFailed`. `null` means not signed in, or `GetSandUsageStatus` and `GetCurrentPeriodUsage` both failed after one refresh. A usage failure does not call `store.clear()`.

- [ ] **Step 1: Write the failing usage script**

Create `scripts/grok-bot-usage-e2e.ts`. It writes `.openbot-build/grok-bot-usage-e2e/report.json`.

Use one loopback server. Seed a Grok Bot account file with access token `grok-access-e2e` and refresh token `grok-refresh-e2e`. Write a separate CLI file `{ "accessToken": "cli-access", "refreshToken": "cli-refresh" }` and keep its bytes.

The server records the bearer token and the path. It does not record the token in the report. The report stores `usedGrokToken: true` when every dashboard call used `grok-access-e2e`, and `usedCliToken: false`.

Cases, each a fresh store:

1. **Weekly and on-demand.** `GetSandUsageStatus` returns `{ "sandUsagePercent": 40, "nextResetTimestampUtc": "2026-11-06T18:00:00.000Z", "hasAvailableUsage": true, "upgradeRecommendation": "raise", "sandTrialExpiresAt": "2020-01-01T00:00:00.000Z" }`. `GetCurrentPeriodUsage` returns `{ "planUsage": { "autoPercentUsed": 99, "apiPercentUsed": 88 }, "billingCycleEnd": "1760000000000", "spendLimitUsage": { "individualUsed": 300, "individualLimit": 5000 } }`. `GetTeams` returns `{ "teams": [] }`. `GetSandTrialClaimStatus` returns `{}`. Assert `includedUsedPercent` is 40, not 99. Assert `includedResetsAt` is `Date.parse("2026-11-06T18:00:00.000Z") / 1000`. Assert `onDemand.usedUsd` is 3, `onDemand.limitUsd` is 50, and `onDemand.usedPercent` is 6. Assert `changeLimit` is true and `JSON.stringify(summary)` does not contain `raise`. Assert `trialActive` is false and `enterprise` is false.
2. **Alias.** A body with `usagePercent: 15` and no `sandUsagePercent` maps `includedUsedPercent` to 15.
3. **No grant.** A body with neither percent maps `includedUsedPercent` to null. `grokBotUsageRow` returns null.
4. **Enterprise.** `GetTeams` returns `{ "teams": [{ "id": "t1" }] }`. `enterprise` is true. `grokBotUsageRow` has no included window. An on-demand window remains when `individualLimit` is greater than 0.
5. **Pooled flag.** `usesPooledEnterpriseAllowance: true` on `GetSandUsageStatus` also sets `enterprise` true and drops the included window, even when `teams` is empty.
6. **Trial claim.** `GetSandTrialClaimStatus` `{ "claimable": true }` sets `trialClaim` true. A body with no `claimable` boolean sets it false. `sandTrialExpiresAt` one day after the script's `now` sets `trialActive` true.
7. **Missing cap.** `individualLimit: 0` sets `onDemand` to null.
8. **Refresh once.** The first `GetSandUsageStatus` returns 401. The script's `POST /oauth/token` returns a new access token `grok-access-e2e-2`. The retry uses that bearer and then returns the weekly body from case 1. A second 401 does not call refresh again.
9. **CLI file.** After every case, the CLI file bytes are the original bytes.

`grokBotUsageRow` for case 1:

- `name` is the English catalog string for `account.usage.grokBot` (`Grok Bot`).
- `provider` is `"grok"`.
- `accountId` is `"grok-bot"`.
- `sharedQuotaWith` is null.
- `reportsUsage` is true.
- The first window label is the English string for `account.usage.grokBot.included` (`Included`). `remainingPercent` is 60. `resetsAt` is the included reset.
- The second window label is the English template `account.usage.grokBot.onDemandLabel` with `{used}` and `{limit}` set to `createFormat("en").currencyUsd(3)` and `createFormat("en").currencyUsd(50)`. `remainingPercent` is 94.

The report is `{ "passed": true, "weekly": true, "ignoresPlanUsage": true, "alias": true, "noGrant": true, "enterprise": true, "pooled": true, "trial": true, "noCap": true, "refreshed": true, "cliUntouched": true, "usedGrokToken": true, "usedCliToken": false }`. Exit 1 when `passed` is false.

- [ ] **Step 2: Run the script and confirm it fails**

Run: `bun scripts/grok-bot-usage-e2e.ts`

Expected: FAIL. `src/backend/grok-bot/grok-bot-usage.ts` does not exist.

- [ ] **Step 3: Implement the summary**

Create `src/backend/grok-bot/grok-bot-usage.ts`.

`readGrokBotUsageSummary` loads the account. No record returns null. When `accessTokenNeedsRefresh` is true, call `refreshGrokBotAccessToken` first. Use the saved access token. Do not import `readCursorUsage` or `cursorAuthFile`.

Send the four POSTs above with `redirect: "manual"` and a 10 s timeout, the same limit `cursor-usage.ts` uses (`CURSOR_USAGE_TIMEOUT_MS` is 10_000). Copy that number here as `GROK_BOT_USAGE_TIMEOUT_MS`. Do not export the CLI helper.

Read percents from `sandUsagePercent`, then `usagePercent`. Clamp to 0–100. Accept a finite number only. Read `nextResetTimestampUtc` with `Date.parse`. A failed parse is null. Do not add 7 days when the field is missing.

Read `spendLimitUsage.individualUsed` and `individualLimit` as a finite number or a numeric string, the same way `Int64` works in `cursor-usage.ts`. Divide by 100 for dollars. `usedPercent` is `individualUsed / individualLimit * 100`, clamped. `billingCycleEnd` is unix milliseconds. Divide by 1000 for `onDemand.resetsAt`. Ignore `planUsage`.

`upgradeRecommendation` sets `changeLimit` when it is a non-empty string. Omit the string from the return value. Ignore `onDemandSettings.dashboardUrl` and every other URL in the body.

`GetTeams` failure or a body that is not `{ teams: object[] }` with length greater than 0 means `enterprise` is false, except when `usesPooledEnterpriseAllowance` is true. `GetSandTrialClaimStatus` failure means `trialClaim` is false.

On HTTP 401 from `GetSandUsageStatus` or `GetCurrentPeriodUsage`, call `refreshGrokBotAccessToken` once and retry those two calls once. Do not loop. `GetTeams` and `GetSandTrialClaimStatus` failures stay soft. Register the access token with `registerSecretValue` before the calls.

`grokBotUsageRow`:

- Returns null when `includedUsedPercent` is null and `onDemand` is null.
- When `enterprise` is true, omit the included window. Keep the on-demand window when `onDemand` is set.
- Included window: `usedPercent` is `includedUsedPercent`, `windowDurationMins` is null, `resetsAt` is `includedResetsAt`. Build the row with the same `usageRemainingPercent` and `usageTone` helpers the provider rows use. The label is `text.t("account.usage.grokBot.included")`.
- On-demand window: `usedPercent` is `onDemand.usedPercent`, `resetsAt` is `onDemand.resetsAt`. The label is `text.t("account.usage.grokBot.onDemandLabel", { used: text.format.currencyUsd(onDemand.usedUsd), limit: text.format.currencyUsd(onDemand.limitUsd) })`. `currencyUsd` is the method on `AppFormat` in `packages/i18n/src/format.ts`. Do not call `toLocaleString`.
- `name` is `text.t("account.usage.grokBot")`.
- `provider` is `"grok"`. `accountId` is `GROK_BOT_USAGE_ACCOUNT_ID`. `sharedQuotaWith` is null. `reportsUsage` is true. `ringWindows` is the same list as `windows`.
- Add optional `changeLimit?: boolean` on `AccountUsageProviderRow`. Set it from `summary.changeLimit`. Provider rows leave it unset.

Add the English keys in `packages/i18n/src/messages/en/account.ts`:

```ts
"account.usage.grokBot": "Grok Bot",
"account.usage.grokBot.included": "Included",
"account.usage.grokBot.onDemandLabel": "On demand · {used} of {limit}",
"account.usage.grokBot.changeLimit": "Change limit",
"account.usage.grokBot.trial": "Trial",
"account.usage.grokBot.enterprise": "Team pool. This is not a personal included limit.",
```

Leave the other locales without these keys.

- [ ] **Step 4: Run the usage script**

Run: `bun scripts/grok-bot-usage-e2e.ts`

Expected: exit 0. The report fields in Step 1 are all true, and `usedCliToken` is false.

- [ ] **Step 5: Show the row where provider usage already shows**

Add `getUsage: request<undefined, GrokBotUsageSummary | null>()("grok-bot:get-usage")` to `IPC_ENDPOINTS.grokBot`. The handler calls `readGrokBotUsageSummary` with no `apiBaseUrl`, so the call uses `https://api2.cursor.sh`. The preload decoder `decodeGrokBotUsageSummary` checks the fields above and throws `new Error("Invalid Grok Bot response.")` when the payload contains `accessToken`, `refreshToken`, `upgradeRecommendation`, or `dashboardUrl`. The mock returns null.

`usePlanLimitRows` appends `grokBotUsageRow` after `accountUsageProviderRows`. It reads `window.openbot.grokBot.getUsage()` only when `getStatus().signedIn` is true. A signed-out account adds no row. Do not write the summary into `auth.accountUsage()` or `AccountUsage.limits`. Do not change `WebWorkspace.tsx`. The web client has no Grok Bot account.

`AccountUsageDetails` already prints `row.name` and the window list. That name is "Grok Bot" on this row and the Cursor provider name on the Cursor row. In `UsageRings`, when `row.changeLimit` is true, add a button under the window list. The button label is `t("account.usage.grokBot.changeLimit")`. The click calls `openUrl("https://cursor.com/dashboard/spending")`. Pass `openUrl` into `PageRail` from `WorkspacePageRail` as `appPort().openUrl`. No other row shows that button. Do not open `onDemandSettings.dashboardUrl`.

In `GrokBotAccountPanel` from Task 6, add:

```ts
usage: GrokBotUsageSummary | null;
onChangeLimit: () => void;
onTrial: () => void;
```

When `usage` is non-null, render `AccountUsageWindowList` with the windows from `grokBotUsageRow`. When `enterprise` is true, also show `t("account.usage.grokBot.enterprise")`. When `changeLimit` is true, show the Change limit button. When `trialClaim` is true, show the Trial button. `ServerGrokBotPanel` loads `api.getUsage()` with the agent list and passes `onChangeLimit` as `openUrl("https://cursor.com/dashboard/spending")` and `onTrial` as `openUrl("https://cursor.com/dashboard")`.

Add this paragraph under the Grok Bot account section in `docs/architecture/agents.md`:

```markdown
The page rail shows a Grok Bot ring when that account is signed in on this computer.
The ring uses GetSandUsageStatus and the on-demand fields of GetCurrentPeriodUsage
with the Grok Bot account token. The Cursor provider ring still uses the CLI token
and readCursorUsage. The two rows use different labels.
```

- [ ] **Step 6: Typecheck and coverage**

Run: `bun run typecheck:node`

Expected: exit 0.

Run: `bun run typecheck:renderer`

Expected: exit 0.

Run: `bun run test:desktop -- src/main/ipc-channel-coverage.test.ts`

Expected: exit 0. The preload bridge includes `grok-bot:get-usage`.

Run: `bunx biome check --write --max-diagnostics=none src/backend/grok-bot/grok-bot-usage.ts scripts/grok-bot-usage-e2e.ts packages/contracts/src/ipc-grok-bot.ts packages/contracts/src/ipc-endpoints.ts src/main/ipc/grok-bot-handlers.ts src/main/grok-bot-account-service.ts src/preload/grok-bot-decoding.ts src/preload/index.ts src/renderer/src/preview/mock-openbot.ts packages/ui/src/features/account/account-usage-view.ts packages/ui/src/features/account/AccountUsageDetails.tsx packages/ui/src/features/window/PageRail.tsx src/renderer/src/features/usage/plan-limit-rows.ts src/renderer/src/features/servers/ServerGrokBotPanel.tsx packages/ui/src/features/grok-bot/GrokBotAccountPanel.tsx packages/i18n/src/messages/en/account.ts docs/architecture/agents.md`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/backend/grok-bot/grok-bot-usage.ts scripts/grok-bot-usage-e2e.ts \
  packages/contracts/src/ipc-grok-bot.ts packages/contracts/src/ipc-endpoints.ts \
  src/main/ipc/grok-bot-handlers.ts src/main/grok-bot-account-service.ts \
  src/preload/grok-bot-decoding.ts src/preload/index.ts \
  src/renderer/src/preview/mock-openbot.ts \
  packages/ui/src/features/account/account-usage-view.ts \
  packages/ui/src/features/account/AccountUsageDetails.tsx \
  packages/ui/src/features/window/PageRail.tsx \
  src/renderer/src/features/usage/plan-limit-rows.ts \
  src/renderer/src/features/servers/ServerGrokBotPanel.tsx \
  packages/ui/src/features/grok-bot/GrokBotAccountPanel.tsx \
  packages/i18n/src/messages/en/account.ts \
  docs/architecture/agents.md
git commit -m "feat: show Grok Bot account usage apart from Cursor provider usage"
```

## Spec coverage

| Requirement | Task |
| --- | --- |
| Sand login UI and storage apart from Cursor CLI auth | Tasks 2 and 6 |
| `redirectTarget=cli`, no `sand://` | Tasks 1 and 2 |
| Token refresh and sign-out | Task 3 |
| `listAgents` and `createAgent` | Task 4 |
| IPC that does not leak tokens | Task 5 |
| Zip import and Cursor provider Connect stay | Tasks 1, 2, and 6 |
| Tests with reports under `.openbot-build/` | Tasks 1–4 and 7 |
| Sand usage from the Grok Bot account token, labeled "Grok Bot" | Task 7 |
| Cursor provider usage stays on `readCursorUsage` | Task 7 |
| No mobile app | Non-goals |
| `createAgentFromTemplate` named, not invented | Non-goals |

## Placeholders

No step uses an open question, a missing path, or a missing command. `createAgentFromTemplate` is excluded because its fields are not in the verified notes and not in `grokbot_api` 1.2.0. Task 7 owns the `claimable` boolean on `GetSandTrialClaimStatus` because the verified notes name that RPC and do not name its fields.
