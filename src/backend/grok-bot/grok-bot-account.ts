import { readFile, rm } from "node:fs/promises";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import { cursorLoginHandshake, pollCursorLoginTokens } from "../agent/cursor-login-poll";
import { writeJsonFileAtomically } from "../atomic-json-file";

const DEFAULT_WEBSITE_URL = "https://cursor.com";
const DEFAULT_API_BASE_URL = "https://api2.cursor.sh";
/** Cursor's published public client id for the refresh_token grant. Not an OpenBot secret. */
const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

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

export interface GrokBotRefreshOptions {
  authFile: string;
  cipher: SecretCipher;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** True when a JWT expires in less than five minutes. A token that is not a JWT returns false. */
export function accessTokenNeedsRefresh(accessToken: string, now: number): boolean {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return false;
  const middle = parts[1];
  if (!middle) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(middle, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!isDynamicRecord(payload) || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return false;
  return payload.exp * 1000 < now + REFRESH_MARGIN_MS;
}

export const refreshGrokBotAccessToken = Effect.fn("GrokBotAccount.refresh")(function* (
  options: GrokBotRefreshOptions,
) {
  const store = new GrokBotAccountStore(options.authFile, options.cipher);
  const record = yield* store.load();
  if (!record) return null;
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? process.env.CURSOR_API_BASE_URL ?? DEFAULT_API_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = yield* Effect.tryPromise({
    try: () =>
      fetchImpl(new URL("/oauth/token", apiBaseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        redirect: "manual",
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CURSOR_OAUTH_CLIENT_ID,
          refresh_token: record.refreshToken,
        }),
      }),
    catch: () => sessionFailure(),
  });
  if (response.status < 200 || response.status >= 300) return yield* Effect.fail(sessionFailure());
  const body = yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: () => sessionFailure(),
  });
  if (!isDynamicRecord(body)) return yield* Effect.fail(sessionFailure());
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (body.should_logout === true || accessToken.length === 0) {
    yield* store.clear();
    return null;
  }
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0 ? body.refresh_token : record.refreshToken;
  registerSecretValue(accessToken);
  registerSecretValue(refreshToken);
  const next: GrokBotAccountRecord = { ...record, accessToken, refreshToken };
  yield* store.save(next);
  return next;
});

function sessionFailure(): GrokBotAccountFailed {
  return new GrokBotAccountFailed({ cause: new Error(sourceText("error.provider.grokBotSessionEnded")) });
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

  readonly refreshAccess = Effect.fn("GrokBotAccountStore.refreshAccess")(function* (
    this: GrokBotAccountStore,
    options: { apiBaseUrl?: string; fetchImpl?: typeof fetch; now?: () => number },
  ) {
    return yield* refreshGrokBotAccessToken({
      authFile: this.#path,
      cipher: this.#cipher,
      apiBaseUrl: options.apiBaseUrl,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
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
