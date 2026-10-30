import { isDynamicRecord } from "@openbot/contracts/runtime-values";

/**
 * Retry decisions for a provider stream that dies before the turn has an answer.
 *
 * Ported from BotAI `source/host/runner/transient-stream-error.ts`. OpenBot has no Grok host
 * runner, so `AcpAgentClient` applies this policy to `session/prompt`. BotAI checkpoint resume,
 * acknowledgement deferral, and the `SAND_AUTOMATION_*` policy are not used here: an ACP session
 * cannot resume a partial stream, and every provider turn uses this one prompt.
 *
 * Environment names follow BotAI's overload policy with an OpenBot prefix:
 * `OPENBOT_STREAM_RETRY_ATTEMPTS`, `OPENBOT_STREAM_RETRY_BASE_MS`, `OPENBOT_STREAM_RETRY_MAX_MS`.
 */

const TRANSIENT_ERRNO_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ENETRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
]);

const TRANSIENT_MESSAGE_TOKENS = [
  "econnreset",
  "etimedout",
  "epipe",
  "econnaborted",
  "econnrefused",
  "enetreset",
  "enetunreach",
  "ehostunreach",
  "socket hang up",
  "premature close",
  "stream closed",
  "closed stream",
  "connection reset",
  "connection closed",
  "connection terminated",
  "other side closed",
  "network error",
  "the operation was aborted",
  "[aborted]",
  "[unavailable]",
  "[deadline_exceeded]",
];

const PROVIDER_CAPACITY_MESSAGE_TOKENS = ["engine is currently overloaded", "engine_overloaded_error"];

const PROVIDER_TRANSIENT_MESSAGE_TOKENS = ['"code":"server_error"', '"type":"server_error"'];

interface ErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
  readonly errors?: unknown;
  readonly lastError?: unknown;
  readonly name?: unknown;
  readonly reason?: unknown;
  readonly isStepRetriesExhausted?: unknown;
  readonly isConversationTooLarge?: unknown;
  readonly isTranscriptAppendAfterCheckpointError?: unknown;
  readonly isFirstTokenStall?: unknown;
  readonly retryable?: unknown;
  readonly isRetryable?: unknown;
  readonly terminal?: unknown;
  readonly displayInfo?: unknown;
  readonly metadata?: unknown;
  readonly responseBody?: unknown;
  readonly data?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly errorKind?: unknown;
  readonly type?: unknown;
  readonly connectCode?: unknown;
  readonly errorCode?: unknown;
  readonly "retry-after"?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return isDynamicRecord(value);
}

function visit(error: unknown, predicate: (value: ErrorLike) => boolean, seen = new Set<object>()): boolean {
  if (!isErrorLike(error) || seen.has(error)) return false;
  seen.add(error);
  const nested = [error.cause, error.lastError, ...(Array.isArray(error.errors) ? error.errors : [])];
  return predicate(error) || nested.some((child) => child != null && visit(child, predicate, seen));
}

/**
 * BotAI `source/shared/provider-authentication-error.ts`. A sign-in failure must not be sent again.
 */
function isProviderAuthenticationError(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error === "string") {
    return /^(authentication required|unauthenticated|invalid api key|invalid_api_key)\b/i.test(error.trim());
  }
  if (!isDynamicRecord(error) || seen.has(error)) return false;
  seen.add(error);
  return (
    error.errorKind === "provider_auth_required" ||
    error.statusCode === 401 ||
    error.status === 401 ||
    error.code === "UNAUTHENTICATED" ||
    error.code === "invalid_api_key" ||
    isProviderAuthenticationError(error.message, seen) ||
    isProviderAuthenticationError(error.cause, seen) ||
    isProviderAuthenticationError(error.lastError, seen) ||
    (Array.isArray(error.errors) && error.errors.some((child) => isProviderAuthenticationError(child, seen)))
  );
}

function messageLooksTransient(message: string): boolean {
  const lower = message.toLowerCase().trim();
  // Undici can surface a stream reset as the bare word "terminated". An exact match keeps an
  // intentional tool or process termination from becoming a provider retry.
  return lower === "terminated" || TRANSIENT_MESSAGE_TOKENS.some((token) => lower.includes(token));
}

function isTransientStreamError(error: unknown): boolean {
  if (typeof error === "string") return messageLooksTransient(error);
  return visit(
    error,
    (value) =>
      (typeof value.code === "string" && TRANSIENT_ERRNO_CODES.has(value.code.toUpperCase())) ||
      (typeof value.message === "string" && messageLooksTransient(value.message)),
  );
}

function isConversationTooLargeRefusal(error: unknown): boolean {
  return visit(error, (value) => value.isConversationTooLarge === true);
}

function messageLooksLikeContextOverflow(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("maximum prompt length is") && lower.includes("request contains") && lower.includes("tokens");
}

function isContextOverflowDeadEnd(error: unknown): boolean {
  if (typeof error === "string") return messageLooksLikeContextOverflow(error);
  return visit(
    error,
    (value) =>
      value.name === "InputTokenLimitError" ||
      ((value.isStepRetriesExhausted === true || value.name === "StepRetriesExhaustedError") &&
        value.reason === "summarization-retries") ||
      (typeof value.message === "string" && messageLooksLikeContextOverflow(value.message)),
  );
}

function messageLooksLikeProviderCapacity(message: string): boolean {
  const lower = message.toLowerCase();
  return PROVIDER_CAPACITY_MESSAGE_TOKENS.some((token) => lower.includes(token));
}

function dataLooksLikeProviderCapacity(data: unknown): boolean {
  if (!isDynamicRecord(data)) return false;
  const error = data.error;
  return isDynamicRecord(error) && error.type === "engine_overloaded_error";
}

function valueLooksLikeProviderCapacity(value: ErrorLike): boolean {
  if (typeof value.message === "string" && messageLooksLikeProviderCapacity(value.message)) return true;
  if (typeof value.responseBody === "string" && messageLooksLikeProviderCapacity(value.responseBody)) return true;
  if (dataLooksLikeProviderCapacity(value.data)) return true;
  if (!isErrorLike(value.displayInfo)) return false;
  const info = value.displayInfo;
  return (
    info.connectCode === "Unavailable" ||
    info.connectCode === 14 ||
    ((info.connectCode === "ResourceExhausted" || info.connectCode === 8) &&
      (info.errorCode === "RESOURCE_EXHAUSTED" || info.errorCode === 8))
  );
}

function hasProviderCapacitySignal(error: unknown): boolean {
  return typeof error === "string"
    ? messageLooksLikeProviderCapacity(error)
    : visit(error, valueLooksLikeProviderCapacity);
}

function messageLooksLikeProviderTransient(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    PROVIDER_TRANSIENT_MESSAGE_TOKENS.some((token) => lower.includes(token)) ||
    /direct request failed \((?:500|502|503|504)(?:\D|$)/i.test(message)
  );
}

function hasProviderTransientSignal(error: unknown): boolean {
  if (typeof error === "string") return messageLooksLikeProviderTransient(error);
  return visit(
    error,
    (value) =>
      value.code === "server_error" ||
      value.name === "InternalServerError" ||
      (typeof value.message === "string" && messageLooksLikeProviderTransient(value.message)),
  );
}

export function isRetryableProviderError(error: unknown): boolean {
  if (isProviderAuthenticationError(error)) return false;
  if (isContextOverflowDeadEnd(error) || isConversationTooLargeRefusal(error)) return false;
  const retryable =
    isTransientStreamError(error) ||
    hasProviderCapacitySignal(error) ||
    hasProviderTransientSignal(error) ||
    visit(error, (value) => value.retryable === true || value.isRetryable === true);
  if (!retryable) return false;
  return !visit(
    error,
    (value) => value.terminal === true || value.name === "NonRetriableError" || value.name === "ActionRequiredError",
  );
}

export class FirstTokenStallError extends Error {
  readonly isFirstTokenStall = true;

  constructor(deadlineMs: number) {
    super(`The model provider did not start responding within ${Math.round(deadlineMs / 1_000)}s.`);
    this.name = "FirstTokenStallError";
  }
}

function isFirstTokenStallError(error: unknown): boolean {
  return (
    error instanceof FirstTokenStallError ||
    (isDynamicRecord(error) && (error.name === "FirstTokenStallError" || error.isFirstTokenStall === true))
  );
}

export function shouldRetryTurnAttempt(input: {
  canceled: boolean;
  error: unknown;
  streamOutputProduced: boolean;
  resumeCheckpointAvailable: boolean;
  automationIsRetryable?: (error: unknown) => boolean;
}): boolean {
  if (isProviderAuthenticationError(input.error)) return false;
  if (input.canceled || (isDynamicRecord(input.error) && input.error.isTranscriptAppendAfterCheckpointError === true)) {
    return false;
  }
  // ACP has no BotAI checkpoint, so `resumeCheckpointAvailable` stays false and a turn that
  // already showed text or a tool call is not sent again.
  const safe = !input.streamOutputProduced || input.resumeCheckpointAvailable;
  if (safe && (isRetryableProviderError(input.error) || isFirstTokenStallError(input.error))) return true;
  return input.automationIsRetryable?.(input.error) ?? false;
}

export function computeBackoffDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
}): number {
  const random = params.random ?? Math.random;
  const base = Math.max(0, params.baseDelayMs);
  const cap = Math.max(base, params.maxDelayMs);
  const exponential = Math.min(cap, base * 2 ** Math.max(0, params.attempt - 1));
  return Math.min(cap, Math.round(exponential / 2 + random() * (exponential / 2)));
}

export const MAX_SERVER_RETRY_AFTER_MS = 30_000;

export function computeServerPacedDelayMs(params: { retryAfterMs: number; random?: () => number }): number {
  const random = params.random ?? Math.random;
  return Math.min(Math.round(params.retryAfterMs + random() * (params.retryAfterMs / 2)), MAX_SERVER_RETRY_AFTER_MS);
}

function retryAfterSeconds(metadata: unknown): number | undefined {
  let raw: string | number | undefined;
  if (metadata instanceof Map) {
    const value = metadata.get("retry-after");
    if (typeof value === "string" || typeof value === "number") raw = value;
  } else if (typeof Headers !== "undefined" && metadata instanceof Headers) {
    const value = metadata.get("retry-after");
    if (typeof value === "string" && value !== "") raw = value;
  } else if (isErrorLike(metadata)) {
    const value = metadata["retry-after"];
    if (typeof value === "string" || typeof value === "number") raw = value;
  }
  if (raw == null || raw === "") return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds;
}

export function serverRetryAfterMsFromError(error: unknown): number | undefined {
  let found: number | undefined;
  visit(error, (value) => {
    const seconds = retryAfterSeconds(value.metadata);
    if (seconds == null) return false;
    found = Math.min(Math.round(seconds * 1_000), MAX_SERVER_RETRY_AFTER_MS);
    return true;
  });
  return found;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (info: { attempt: number; delayMs: number; serverPaced: boolean; error: unknown }) => void;
}

export async function runWithTransientRetry<T>(run: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= maxAttempts || !(policy.isRetryable ?? isTransientStreamError)(error)) throw error;
      const server = serverRetryAfterMsFromError(error);
      const delayMs =
        server == null
          ? computeBackoffDelayMs({
              attempt,
              baseDelayMs: policy.baseDelayMs,
              maxDelayMs: policy.maxDelayMs,
              ...(policy.random == null ? {} : { random: policy.random }),
            })
          : computeServerPacedDelayMs({
              retryAfterMs: server,
              ...(policy.random == null ? {} : { random: policy.random }),
            });
      policy.onRetry?.({ attempt, delayMs, serverPaced: server != null, error });
      await (policy.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
    }
  }
}

const DEFAULT_OVERLOAD_STREAM_RETRY_MAX_ATTEMPTS = 4;
const DEFAULT_OVERLOAD_STREAM_RETRY_BASE_DELAY_MS = 750;
const DEFAULT_OVERLOAD_STREAM_RETRY_MAX_DELAY_MS = 6_000;

function readIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(env[name]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function resolveOverloadStreamRetryPolicy(
  overrides: Partial<RetryPolicy> = {},
  env: NodeJS.ProcessEnv = process.env,
): RetryPolicy {
  return {
    maxAttempts: readIntEnv(env, "OPENBOT_STREAM_RETRY_ATTEMPTS", DEFAULT_OVERLOAD_STREAM_RETRY_MAX_ATTEMPTS, 1),
    baseDelayMs: readIntEnv(env, "OPENBOT_STREAM_RETRY_BASE_MS", DEFAULT_OVERLOAD_STREAM_RETRY_BASE_DELAY_MS, 0),
    maxDelayMs: readIntEnv(env, "OPENBOT_STREAM_RETRY_MAX_MS", DEFAULT_OVERLOAD_STREAM_RETRY_MAX_DELAY_MS, 0),
    ...overrides,
  };
}
