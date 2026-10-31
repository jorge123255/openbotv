import type { OllamaQuotaSnapshot, OllamaQuotaWindow } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

function fail(): never {
  throw new Error("Invalid Ollama quota response.");
}
function text(value: unknown): string {
  return typeof value === "string" && value.length <= 4_096 ? value : fail();
}
function nonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail();
}
function optionalNumber(value: unknown): number | null {
  return value === null ? null : nonnegative(value);
}
function windowFromMain(value: unknown): OllamaQuotaWindow {
  if (!isDynamicRecord(value) || (value.id !== "included" && value.id !== "session" && value.id !== "weekly")) fail();
  const usedPercent = optionalNumber(value.usedPercent);
  if (usedPercent !== null && usedPercent > 100) fail();
  return {
    id: value.id,
    usedPercent,
    startsAt: optionalNumber(value.startsAt),
    resetsAt: optionalNumber(value.resetsAt),
    balanceUsd: optionalNumber(value.balanceUsd),
    allowanceUsd: optionalNumber(value.allowanceUsd),
    warningId: value.warningId === null ? null : text(value.warningId),
  };
}

/** Rebuild an allowlisted object. Provider payload fields and credentials cannot reach a view. */
export function decodeOllamaQuota(value: unknown): OllamaQuotaSnapshot | null {
  if (value === null) return null;
  if (!isDynamicRecord(value) || (value.state !== "fresh" && value.state !== "stale" && value.state !== "unavailable"))
    fail();
  if (!Array.isArray(value.windows) || value.windows.length > 3) fail();
  return {
    connectionId: text(value.connectionId),
    connectionName: text(value.connectionName),
    poolId: text(value.poolId),
    state: value.state,
    checkedAt: optionalNumber(value.checkedAt),
    retryAt: nonnegative(value.retryAt),
    windows: value.windows.map(windowFromMain),
    purchasedBalanceUsd: optionalNumber(value.purchasedBalanceUsd),
  };
}
