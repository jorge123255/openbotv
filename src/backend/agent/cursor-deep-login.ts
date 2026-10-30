import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import { cursorAuthFile } from "../cursor-usage";
import { CliCodeLoginFailed, type CliCodePrompt } from "./cli-code-login";
import type { CliLoginProcess } from "./cli-login-flow";
import { cursorLoginHandshake, pollCursorLoginTokens } from "./cursor-login-poll";

const DEFAULT_WEBSITE_URL = "https://cursor.com";
const DEFAULT_API_BASE_URL = "https://api2.cursor.sh";

export interface CursorDeepLoginOptions {
  timeoutMs: number;
  /** Defaults to `CURSOR_WEBSITE_URL`, then `https://cursor.com`. */
  websiteUrl?: string;
  /** Defaults to `CURSOR_API_BASE_URL`, then `https://api2.cursor.sh`. */
  apiBaseUrl?: string;
  /** Defaults to the Cursor CLI auth file. */
  authFile?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The wait between polls. The default grows from 1 s to 10 s, as BotAI does. */
  delay?: (attempt: number) => number;
}

/**
 * Starts the Cursor sign-in BotAI uses for Grok Bot: `loginDeepControl` plus `GET /auth/poll`.
 *
 * The page is the link the user opens. The poll writes the tokens into the Cursor CLI auth file,
 * and on macOS into the same keychain item the CLI reads. No CLI process has to stay open.
 */
export const startCursorDeepLogin = Effect.fn("CursorDeepLogin.start")(function* (options: CursorDeepLoginOptions) {
  const websiteUrl = stripTrailingSlash(options.websiteUrl ?? process.env.CURSOR_WEBSITE_URL ?? DEFAULT_WEBSITE_URL);
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? process.env.CURSOR_API_BASE_URL ?? DEFAULT_API_BASE_URL);
  const login = cursorLoginHandshake(websiteUrl);
  if (!login.loginUrl.startsWith("https://")) {
    return yield* new CliCodeLoginFailed({ cause: new Error(sourceText("error.provider.codeLoginNoLink")) });
  }
  registerSecretValue(login.verifier);
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (abort) => Effect.sync(() => abort.abort()),
  );
  const deadline = (options.now ?? Date.now)() + options.timeoutMs;
  const done = pollCursorLoginTokens({
    apiBaseUrl,
    uuid: login.uuid,
    verifier: login.verifier,
    signal: controller.signal,
    deadline,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.delay !== undefined ? { delay: options.delay } : {}),
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
  return {
    done,
    prompt: Effect.succeed<CliCodePrompt>({ flow: "link", verificationUrl: login.loginUrl }),
    submit() {
      throw new Error(sourceText("error.provider.codeLoginNotWaiting"));
    },
  } satisfies CliLoginProcess;
});

/** The Cursor CLI auth file. Other fields stay. On macOS the keychain item is updated too. */
function writeCursorAuth(path: string, tokens: { accessToken: string; refreshToken: string }): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
  renameSync(temporary, path);
  if (process.platform !== "darwin") return;
  try {
    execFileSync(
      "/usr/bin/security",
      ["add-generic-password", "-U", "-a", "cursor-user", "-s", "cursor-access-token", "-w", tokens.accessToken],
      { timeout: 3_000, stdio: "ignore" },
    );
  } catch {
    // A keychain failure can quote the token. The auth file is the sign-in that remains.
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}
