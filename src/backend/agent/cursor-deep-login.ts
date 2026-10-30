import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result } from "effect";
import { cursorAuthFile } from "../cursor-usage";
import { CliCodeLoginFailed, type CliCodePrompt } from "./cli-code-login";
import type { CliLoginProcess } from "./cli-login-flow";

const DEFAULT_WEBSITE_URL = "https://cursor.com";
const DEFAULT_API_BASE_URL = "https://api2.cursor.sh";
/** The same bound BotAI uses for `loginDeepControl` (`pollAuthenticationStatus`). */
const MAX_POLL_ATTEMPTS = 150;

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
  const login = cursorLoginParams(websiteUrl);
  if (!login.loginUrl.startsWith("https://")) {
    return yield* new CliCodeLoginFailed({ cause: new Error(sourceText("error.provider.codeLoginNoLink")) });
  }
  registerSecretValue(login.verifier);
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (abort) => Effect.sync(() => abort.abort()),
  );
  const deadline = (options.now ?? Date.now)() + options.timeoutMs;
  const done = pollCursorLogin({
    ...options,
    apiBaseUrl,
    authFile: options.authFile ?? cursorAuthFile(),
    uuid: login.uuid,
    verifier: login.verifier,
    signal: controller.signal,
    deadline,
  });
  return {
    done,
    prompt: Effect.succeed<CliCodePrompt>({ flow: "link", verificationUrl: login.loginUrl }),
    submit() {
      throw new Error(sourceText("error.provider.codeLoginNotWaiting"));
    },
  } satisfies CliLoginProcess;
});

function cursorLoginParams(websiteUrl: string): { uuid: string; verifier: string; loginUrl: string } {
  const verifier = Buffer.from(randomBytes(32)).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const uuid = randomUUID();
  const url = new URL("/loginDeepControl", websiteUrl);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("uuid", uuid);
  url.searchParams.set("mode", "login");
  url.searchParams.set("redirectTarget", "cli");
  return { uuid, verifier, loginUrl: url.toString() };
}

const pollCursorLogin = Effect.fn("CursorDeepLogin.poll")(function* (options: {
  apiBaseUrl: string;
  authFile: string;
  uuid: string;
  verifier: string;
  signal: AbortSignal;
  deadline: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  delay?: (attempt: number) => number;
}) {
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
    yield* Effect.try({
      try: () => writeCursorAuth(options.authFile, tokens),
      catch: () =>
        new CliCodeLoginFailed({
          cause: new Error(sourceText("error.provider.hostSignInEnded", { provider: "Cursor" })),
        }),
    });
    return;
  }
  return yield* new CliCodeLoginFailed({ cause: new Error(sourceText("error.provider.acpSignInTimedOut")) });
});

function pollDelayMs(attempt: number): number {
  return Math.min(1_000 * 1.2 ** attempt, 10_000);
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

function cursorTokens(value: unknown): { accessToken: string; refreshToken: string } | null {
  if (typeof value !== "object" || value === null || !("accessToken" in value) || !("refreshToken" in value))
    return null;
  const { accessToken, refreshToken } = value;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return null;
  return { accessToken, refreshToken };
}

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
