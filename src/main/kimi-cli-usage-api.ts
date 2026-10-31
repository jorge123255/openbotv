import type { KimiCliUsageWindow } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect, Schema } from "effect";
import { readLimitedBody } from "../backend/limited-body";

class KimiCliUsageUnavailable extends Schema.TaggedError<KimiCliUsageUnavailable>()("KimiCliUsageUnavailable", {
  reason: Schema.Literals(["request", "unsupported", "unsafe", "accountChanged", "serverChanged"]),
}) {}

type Route =
  | "/api/v1/meta"
  | "/api/v1/oauth/userinfo?provider=managed:kimi-code"
  | "/api/v1/oauth/usage?provider=managed:kimi-code";
export type KimiCliFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface KimiCliIdentity {
  server: string;
  account: string;
}

function fail(reason: KimiCliUsageUnavailable["reason"] = "request"): never {
  throw new KimiCliUsageUnavailable({ reason });
}
function nonempty(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 ? value : fail();
}
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function instant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value))
    return null;
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)
    return null;
  const date = value.slice(0, 10);
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? time : null;
}
function meta(value: unknown): string {
  if (!isDynamicRecord(value)) return fail();
  if (value.dangerous_bypass_auth !== false) return fail("unsafe");
  if (value.server_version !== "2.3.3") return fail("unsupported");
  if (instant(value.started_at) === null) return fail();
  return JSON.stringify([nonempty(value.server_id), value.started_at]);
}
function account(value: unknown): string {
  if (!isDynamicRecord(value) || value.kind !== "ok" || !isDynamicRecord(value.userInfo)) return fail();
  const info = value.userInfo;
  if (typeof info.domain !== "number" || !Number.isSafeInteger(info.domain) || info.domain < 0) return fail();
  return JSON.stringify([nonempty(info.userId), nonempty(info.region), info.domain]);
}
function quota(value: unknown) {
  if (!isDynamicRecord(value) || value.kind !== "ok" || !isDynamicRecord(value.quota)) return fail();
  const raw = value.quota;
  if (!isDynamicRecord(raw.usages)) return fail();
  const windows: KimiCliUsageWindow[] = [];
  for (const id of ["limit5h", "limit7d", "monthTotal", "monthCode"] as const) {
    const item = raw.usages[id];
    if (item === undefined || item === null) continue;
    const ratio = isDynamicRecord(item) ? amount(item.usedRatio) : null;
    windows.push({
      id,
      usedRatio: ratio !== null && ratio <= 1 ? ratio : null,
      resetsAt: isDynamicRecord(item) ? instant(item.resetAt) : null,
    });
  }
  const extra = isDynamicRecord(raw.extraUsage) ? raw.extraUsage : null;
  return {
    windows,
    extraBalanceCents: extra ? amount(extra.balanceCents) : null,
    currency: extra && typeof extra.currency === "string" && /^[A-Z]{3}$/.test(extra.currency) ? extra.currency : null,
  };
}

/** GET only, fixed loopback host/routes, no cookies or redirects. No credential-file or CLI access. */
export const readKimiCliUsage = Effect.fn("KimiCliUsage.readApi")(function* (
  port: number,
  token: string,
  fetchImpl: KimiCliFetch,
  controller: AbortController,
  expected: KimiCliIdentity | null,
) {
  const unavailable = () => new KimiCliUsageUnavailable({ reason: "request" });
  const get = Effect.fn("KimiCliUsage.get")(function* (route: Route) {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(`http://127.0.0.1:${port}${route}`, {
          method: "GET",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        }),
      catch: unavailable,
    });
    if (!response.ok || response.redirected) {
      yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());
      return yield* unavailable();
    }
    const body = yield* readLimitedBody(response, 65_536, unavailable);
    return yield* Effect.try({
      try: () => {
        const envelope = JSON.parse(body.toString("utf8"));
        if (!isDynamicRecord(envelope) || envelope.code !== 0) return fail();
        return envelope.data;
      },
      catch: unavailable,
    });
  });
  return yield* Effect.gen(function* () {
    const server = yield* get("/api/v1/meta").pipe(
      Effect.flatMap((data) =>
        Effect.try({
          try: () => meta(data),
          catch: (error) => (error instanceof KimiCliUsageUnavailable ? error : unavailable()),
        }),
      ),
    );
    if (expected && expected.server !== server) return yield* new KimiCliUsageUnavailable({ reason: "serverChanged" });
    const before = yield* get("/api/v1/oauth/userinfo?provider=managed:kimi-code").pipe(
      Effect.flatMap((data) => Effect.try({ try: () => account(data), catch: unavailable })),
    );
    if (expected && expected.account !== before)
      return yield* new KimiCliUsageUnavailable({ reason: "accountChanged" });
    const reading = yield* get("/api/v1/oauth/usage?provider=managed:kimi-code").pipe(
      Effect.flatMap((data) => Effect.try({ try: () => quota(data), catch: unavailable })),
    );
    const after = yield* get("/api/v1/oauth/userinfo?provider=managed:kimi-code").pipe(
      Effect.flatMap((data) => Effect.try({ try: () => account(data), catch: unavailable })),
    );
    const serverAfter = yield* get("/api/v1/meta").pipe(
      Effect.flatMap((data) => Effect.try({ try: () => meta(data), catch: unavailable })),
    );
    if (before !== after) return yield* new KimiCliUsageUnavailable({ reason: "accountChanged" });
    if (server !== serverAfter) return yield* new KimiCliUsageUnavailable({ reason: "serverChanged" });
    return { identity: { server, account: before }, ...reading };
  }).pipe(
    Effect.timeoutOrElse({ duration: 15_000, orElse: () => Effect.fail(unavailable()) }),
    Effect.ensuring(Effect.sync(() => controller.abort())),
  );
});
