import type { GrokBotUsageSummary } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result } from "effect";
import { accessTokenNeedsRefresh, GrokBotAccountFailed, type GrokBotAccountStore } from "./grok-bot-account";
import { GROK_BOT_CURSOR_CLIENT_VERSION } from "./grok-bot-gateway";

const GROK_BOT_USAGE_TIMEOUT_MS = 10_000;
const DEFAULT_API = "https://api2.cursor.sh";

export interface GrokBotUsageOptions {
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => number;
}

export const readGrokBotUsageSummary = Effect.fn("GrokBotUsage.read")(function* (
  store: GrokBotAccountStore,
  options: GrokBotUsageOptions = {},
) {
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? DEFAULT_API);
  if (!allowedUsageBase(apiBaseUrl)) {
    return yield* new GrokBotAccountFailed({ cause: new Error(sourceText("error.provider.grokBotSessionEnded")) });
  }
  let record = yield* store.load();
  if (!record) return null;
  const now = options.now ?? Date.now;
  if (accessTokenNeedsRefresh(record.accessToken, now())) {
    const refreshed = yield* store.refreshAccess({ apiBaseUrl, fetchImpl: options.fetchImpl, now });
    if (!refreshed) return null;
    record = refreshed;
  }
  registerSecretValue(record.accessToken);
  const fetchImpl = options.fetchImpl ?? fetch;
  let status = yield* dashboard(fetchImpl, apiBaseUrl, record.accessToken, "GetSandUsageStatus");
  let period = yield* dashboard(fetchImpl, apiBaseUrl, record.accessToken, "GetCurrentPeriodUsage");
  if (status.status === 401 || period.status === 401) {
    const refreshed = yield* store.refreshAccess({ apiBaseUrl, fetchImpl, now });
    if (!refreshed) return null;
    record = refreshed;
    registerSecretValue(record.accessToken);
    status = yield* dashboard(fetchImpl, apiBaseUrl, record.accessToken, "GetSandUsageStatus");
    period = yield* dashboard(fetchImpl, apiBaseUrl, record.accessToken, "GetCurrentPeriodUsage");
  }
  if (!ok(status) && !ok(period)) return null;
  const teams = yield* dashboard(fetchImpl, apiBaseUrl, record.accessToken, "GetTeams");
  const trial = yield* dashboard(fetchImpl, apiBaseUrl, record.accessToken, "GetSandTrialClaimStatus");
  return summarize(
    ok(status) ? status.body : null,
    ok(period) ? period.body : null,
    ok(teams) ? teams.body : null,
    ok(trial) ? trial.body : null,
    now(),
  );
});

function summarize(status: unknown, period: unknown, teams: unknown, trial: unknown, now: number): GrokBotUsageSummary {
  const statusRecord = isDynamicRecord(status) ? status : {};
  const periodRecord = isDynamicRecord(period) ? period : {};
  const included = percent(statusRecord.sandUsagePercent) ?? percent(statusRecord.usagePercent);
  const reset = dateSeconds(statusRecord.nextResetTimestampUtc);
  const spend = isDynamicRecord(periodRecord.spendLimitUsage) ? periodRecord.spendLimitUsage : null;
  const usedCents = spend ? finiteNumber(spend.individualUsed) : null;
  const limitCents = spend ? finiteNumber(spend.individualLimit) : null;
  const onDemand =
    limitCents === null || limitCents === 0 || usedCents === null
      ? null
      : {
          usedUsd: usedCents / 100,
          limitUsd: limitCents / 100,
          usedPercent: clamp(limitCents === 0 ? 0 : (usedCents / limitCents) * 100),
          resetsAt: millisToSeconds(periodRecord.billingCycleEnd),
        };
  const teamList = isDynamicRecord(teams) && Array.isArray(teams.teams) ? teams.teams : [];
  const enterprise = teamList.length > 0 || statusRecord.usesPooledEnterpriseAllowance === true;
  const trialExpiry =
    typeof statusRecord.sandTrialExpiresAt === "string" ? Date.parse(statusRecord.sandTrialExpiresAt) : Number.NaN;
  return {
    includedUsedPercent: included,
    includedResetsAt: reset,
    hasAvailableUsage: statusRecord.hasAvailableUsage === true,
    enterprise,
    trialActive: Number.isFinite(trialExpiry) && trialExpiry > now,
    trialClaim: isDynamicRecord(trial) && trial.claimable === true,
    changeLimit:
      typeof statusRecord.upgradeRecommendation === "string" && statusRecord.upgradeRecommendation.length > 0,
    onDemand,
  };
}

function dashboard(fetchImpl: typeof fetch, apiBaseUrl: string, accessToken: string, method: string) {
  return Effect.gen(function* () {
    const fetched = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          fetchImpl(new URL(`/aiserver.v1.DashboardService/${method}`, apiBaseUrl), {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(GROK_BOT_USAGE_TIMEOUT_MS),
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "connect-protocol-version": "1",
              "x-cursor-client-type": "sand",
              "x-cursor-client-version": GROK_BOT_CURSOR_CLIENT_VERSION,
              "x-sand-box-namespace": "prod",
            },
            body: "{}",
          }),
        catch: (cause) => cause,
      }),
    );
    if (Result.isFailure(fetched)) return { status: 0, body: null };
    const response = fetched.success;
    if (response.status === 401) return { status: 401, body: null };
    if (response.status < 200 || response.status >= 300) return { status: response.status, body: null };
    const text = yield* Effect.result(
      Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => cause,
      }),
    );
    if (Result.isFailure(text) || text.success.length === 0) return { status: response.status, body: {} };
    const parsed = yield* Effect.result(
      Effect.try({
        try: () => JSON.parse(text.success),
        catch: (cause) => cause,
      }),
    );
    return { status: response.status, body: Result.isSuccess(parsed) ? parsed.success : {} };
  });
}

function ok(result: { status: number; body: unknown }): boolean {
  return result.status >= 200 && result.status < 300;
}

function percent(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : clamp(number);
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function dateSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function millisToSeconds(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : number / 1000;
}

function allowedUsageBase(value: string): boolean {
  if (value.startsWith("https://")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}
