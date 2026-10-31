import type { OllamaQuotaWindow } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Schema } from "effect";
import { readLimitedBody } from "../backend/limited-body";

export class OllamaBalanceUnavailable extends Schema.TaggedError<OllamaBalanceUnavailable>()(
  "OllamaBalanceUnavailable",
  { retryAfterMs: Schema.Number },
) {}

export interface OllamaBalance {
  windows: OllamaQuotaWindow[];
  purchasedBalanceUsd: number | null;
}

export type OllamaBalanceFetch = (url: string, init: RequestInit) => Promise<Response>;

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function instant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null;
}

/** Only documented allowance windows yield percentages. History and purchased credit have no denominator. */
function decodeBalance(value: unknown, now: number): OllamaBalance {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.included))
    throw new OllamaBalanceUnavailable({ retryAfterMs: 60_000 });
  const included = value.included;
  const windows: OllamaQuotaWindow[] = [];
  if ("allowance_usd" in included || "balance_usd" in included || "period" in included) {
    const balanceUsd = amount(included.balance_usd);
    const allowanceUsd = amount(included.allowance_usd);
    const period = isDynamicRecord(included.period) ? included.period : {};
    const startsAt = instant(period.from);
    const resetsAt = instant(period.until);
    const validPeriod = startsAt !== null && resetsAt !== null && startsAt <= now && now < resetsAt;
    windows.push({
      id: "included",
      usedPercent:
        validPeriod && balanceUsd !== null && allowanceUsd !== null && allowanceUsd > 0 && balanceUsd <= allowanceUsd
          ? (100 * (allowanceUsd - balanceUsd)) / allowanceUsd
          : null,
      startsAt,
      resetsAt,
      balanceUsd,
      allowanceUsd,
      warningId: null,
    });
  } else {
    for (const id of ["session", "weekly"] as const) {
      const window = included[id];
      if (!isDynamicRecord(window)) continue;
      const remaining = amount(window.remaining_percent);
      const resetsAt = instant(window.resets_at);
      windows.push({
        id,
        usedPercent:
          remaining !== null && remaining <= 100 && resetsAt !== null && resetsAt > now ? 100 - remaining : null,
        startsAt: null,
        resetsAt,
        balanceUsd: null,
        allowanceUsd: null,
        warningId: null,
      });
    }
  }
  if (!windows.length) throw new OllamaBalanceUnavailable({ retryAfterMs: 60_000 });
  return {
    windows,
    purchasedBalanceUsd: isDynamicRecord(value.purchased) ? amount(value.purchased.balance_usd) : null,
  };
}

/** Fixed origin, no redirects/cookies/custom headers, bounded body. Causes and secrets never cross the adapter. */
export const readOllamaBalance = Effect.fn("OllamaBalance.read")(function* (
  apiKey: string,
  now: () => number,
  fetchImpl: OllamaBalanceFetch,
  controller: AbortController,
) {
  const unavailable = () => new OllamaBalanceUnavailable({ retryAfterMs: 60_000 });
  return yield* Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl("https://ollama.com/api/balance", {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        }),
      catch: unavailable,
    });
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const requestedMs =
        retry !== null && /^\d+(?:\.\d+)?$/.test(retry)
          ? Number(retry) * 1_000
          : retry === null
            ? 60_000
            : Date.parse(retry) - now();
      const retryAfterMs = Number.isNaN(requestedMs)
        ? 60_000
        : Math.max(60_000, Math.min(Number.MAX_SAFE_INTEGER - now(), requestedMs));
      yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());
      return yield* new OllamaBalanceUnavailable({
        retryAfterMs,
      });
    }
    if (!response.ok) {
      yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());
      return yield* unavailable();
    }
    const body = yield* readLimitedBody(response, 32_768, unavailable);
    return yield* Effect.try({
      try: () => decodeBalance(JSON.parse(body.toString("utf8")), now()),
      catch: unavailable,
    });
  }).pipe(
    Effect.timeoutOrElse({ duration: 8_000, orElse: () => Effect.fail(unavailable()) }),
    Effect.ensuring(Effect.sync(() => controller.abort())),
  );
});
