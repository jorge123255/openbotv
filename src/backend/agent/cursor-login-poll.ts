import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result } from "effect";
import { CliCodeLoginFailed } from "./cli-code-login";

/** Desktop BotAI uses `cli` so the official Grok Bot `sand://` callback stays with Grok Bot. */
const SAND_AUTH_REDIRECT_TARGET = "cli";
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

function pollDelayMs(attempt: number): number {
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
