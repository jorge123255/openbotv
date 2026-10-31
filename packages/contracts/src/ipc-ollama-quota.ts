/** Local saved-connection usage, separate from the harness's provider-level send limits. */
export interface OllamaQuotaWindow {
  id: "included" | "session" | "weekly";
  usedPercent: number | null;
  startsAt: number | null;
  resetsAt: number | null;
  balanceUsd: number | null;
  allowanceUsd: number | null;
  /** One high-usage episode for this credential pool and window. Null after dismissal. */
  warningId: string | null;
}

export interface OllamaQuotaSnapshot {
  connectionId: string;
  connectionName: string;
  /** Opaque, process-local identity. Contains no account name or credential fingerprint. */
  poolId: string;
  state: "fresh" | "stale" | "unavailable";
  /** Receipt time, not the provider's measurement time. */
  checkedAt: number | null;
  retryAt: number;
  windows: OllamaQuotaWindow[];
  purchasedBalanceUsd: number | null;
}

export const OLLAMA_QUOTA_FRESH_MS = 120_000;

/** A saved OpenAI-compatible address whose key can be bound to the official balance origin. */
export function isOllamaCloudBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://ollama.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["", "/", "/v1", "/v1/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
