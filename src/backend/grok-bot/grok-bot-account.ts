import { readFile, rm } from "node:fs/promises";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import { cursorLoginHandshake, pollCursorLoginTokens } from "../agent/cursor-login-poll";
import { writeJsonFileAtomically } from "../atomic-json-file";

const DEFAULT_WEBSITE_URL = "https://cursor.com";
const DEFAULT_API_BASE_URL = "https://api2.cursor.sh";

export class GrokBotAccountFailed extends Schema.TaggedError<GrokBotAccountFailed>()("GrokBotAccountFailed", {
  cause: Schema.Defect(),
}) {}

export interface SecretCipher {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface GrokBotGatewaySession {
  url: string;
  token: string;
  headers: Readonly<Record<string, string>>;
}

export interface GrokBotAccountRecord {
  accessToken: string;
  refreshToken: string;
  gateway: GrokBotGatewaySession | null;
}

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

export function publicGrokBotStatus(record: GrokBotAccountRecord | null): { signedIn: boolean } {
  return { signedIn: record !== null };
}

export class GrokBotAccountStore {
  readonly #path: string;
  readonly #cipher: SecretCipher;

  constructor(path: string, cipher: SecretCipher) {
    this.#path = path;
    this.#cipher = cipher;
  }

  readonly load = Effect.fn("GrokBotAccountStore.load")(function* (this: GrokBotAccountStore) {
    const read = yield* Effect.result(
      Effect.tryPromise({
        try: () => readFile(this.#path, "utf8"),
        catch: (cause) => cause,
      }),
    );
    if (Result.isFailure(read)) {
      if (isMissingFile(read.failure)) return null;
      return yield* accountFailed();
    }
    const record = yield* Effect.try({
      try: () => decodeRecord(this.#cipher, read.success),
      catch: () => accountFailure(),
    });
    rememberRecord(record);
    return record;
  });

  readonly save = Effect.fn("GrokBotAccountStore.save")(function* (
    this: GrokBotAccountStore,
    record: GrokBotAccountRecord,
  ) {
    rememberRecord(record);
    const payload = this.#cipher.encrypt(JSON.stringify(record)).toString("base64");
    yield* writeJsonFileAtomically(this.#path, { version: 1, payload }, { createDirectory: true }).pipe(
      Effect.mapError(() => accountFailure()),
    );
  });

  readonly clear = Effect.fn("GrokBotAccountStore.clear")(function* (this: GrokBotAccountStore) {
    yield* Effect.tryPromise({
      try: () => rm(this.#path, { force: true }),
      catch: () => accountFailure(),
    });
  });
}

export const startGrokBotSignIn = Effect.fn("GrokBotAccount.signIn")(function* (options: GrokBotSignInOptions) {
  const websiteUrl = stripTrailingSlash(options.websiteUrl ?? process.env.CURSOR_WEBSITE_URL ?? DEFAULT_WEBSITE_URL);
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? process.env.CURSOR_API_BASE_URL ?? DEFAULT_API_BASE_URL);
  const login = cursorLoginHandshake(websiteUrl);
  const store = new GrokBotAccountStore(options.authFile, options.cipher);
  const deadline = (options.now ?? Date.now)() + options.timeoutMs;
  const done = pollCursorLoginTokens({
    apiBaseUrl,
    uuid: login.uuid,
    verifier: login.verifier,
    signal: options.signal,
    deadline,
    fetchImpl: options.fetchImpl,
    now: options.now,
    delay: options.delay,
  }).pipe(
    Effect.mapError(() => accountFailure()),
    Effect.flatMap((tokens) => {
      const record: GrokBotAccountRecord = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        gateway: null,
      };
      return store.save(record).pipe(Effect.as(record));
    }),
  );
  return { verificationUrl: login.loginUrl, done };
});

function accountFailure(): GrokBotAccountFailed {
  return new GrokBotAccountFailed({ cause: new Error(sourceText("error.provider.grokBotSignInEnded")) });
}

function accountFailed(): Effect.Effect<never, GrokBotAccountFailed> {
  return Effect.fail(accountFailure());
}

function rememberRecord(record: GrokBotAccountRecord): void {
  registerSecretValue(record.accessToken);
  registerSecretValue(record.refreshToken);
  if (record.gateway) registerSecretValue(record.gateway.token);
}

function decodeRecord(cipher: SecretCipher, text: string): GrokBotAccountRecord {
  const stored = JSON.parse(text);
  if (!isDynamicRecord(stored) || stored.version !== 1 || typeof stored.payload !== "string") {
    throw new Error(sourceText("error.provider.grokBotSignInEnded"));
  }
  const plain = JSON.parse(cipher.decrypt(Buffer.from(stored.payload, "base64")));
  if (!isDynamicRecord(plain) || typeof plain.accessToken !== "string" || plain.accessToken.length === 0) {
    throw new Error(sourceText("error.provider.grokBotSignInEnded"));
  }
  if (typeof plain.refreshToken !== "string" || plain.refreshToken.length === 0) {
    throw new Error(sourceText("error.provider.grokBotSignInEnded"));
  }
  return {
    accessToken: plain.accessToken,
    refreshToken: plain.refreshToken,
    gateway: decodeGateway(plain.gateway),
  };
}

function decodeGateway(value: unknown): GrokBotGatewaySession | null {
  if (value === null) return null;
  if (
    !isDynamicRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.token !== "string" ||
    !isDynamicRecord(value.headers)
  ) {
    throw new Error(sourceText("error.provider.grokBotSignInEnded"));
  }
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value.headers)) {
    if (typeof header !== "string") throw new Error(sourceText("error.provider.grokBotSignInEnded"));
    headers[name] = header;
  }
  return { url: value.url, token: value.token, headers };
}

function isMissingFile(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}
