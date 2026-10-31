import type { KimiCliUsageSnapshot, KimiCliUsageWindow } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

function fail(): never {
  throw new Error("Invalid Kimi CLI usage response.");
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail();
}
function optionalNumber(value: unknown): number | null {
  return value === null ? null : number(value);
}
function windowValue(value: unknown): KimiCliUsageWindow {
  if (
    !isDynamicRecord(value) ||
    (value.id !== "limit5h" && value.id !== "limit7d" && value.id !== "monthTotal" && value.id !== "monthCode")
  )
    return fail();
  const usedRatio = optionalNumber(value.usedRatio);
  if (usedRatio !== null && usedRatio > 1) return fail();
  return { id: value.id, usedRatio, resetsAt: optionalNumber(value.resetsAt) };
}
/** Local-only IPC. Rebuild an allowlist; raw server metadata, identity and tokens cannot reach views. */
export function decodeKimiCliUsage(value: unknown): KimiCliUsageSnapshot {
  if (
    !isDynamicRecord(value) ||
    typeof value.connected !== "boolean" ||
    (value.state !== "disconnected" && value.state !== "ready" && value.state !== "unavailable")
  )
    return fail();
  if (
    value.reason !== null &&
    value.reason !== "request" &&
    value.reason !== "unsupported" &&
    value.reason !== "unsafe" &&
    value.reason !== "accountChanged" &&
    value.reason !== "serverChanged"
  )
    return fail();
  if (!Array.isArray(value.windows) || value.windows.length > 4) return fail();
  const windows = value.windows.map(windowValue);
  if (new Set(windows.map((window) => window.id)).size !== windows.length) return fail();
  if (value.currency !== null && (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)))
    return fail();
  if (value.state !== "ready" && windows.length > 0) return fail();
  const port = optionalNumber(value.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) return fail();
  if (value.connected !== (port !== null)) return fail();
  return {
    connected: value.connected,
    port,
    state: value.state,
    reason: value.reason,
    checkedAt: optionalNumber(value.checkedAt),
    retryAt: number(value.retryAt),
    windows,
    extraBalanceCents: optionalNumber(value.extraBalanceCents),
    currency: value.currency,
  };
}
