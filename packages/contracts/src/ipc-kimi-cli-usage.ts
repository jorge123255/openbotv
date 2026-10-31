/** Account quotas reported by an existing Kimi CLI web server. Never agent send limits. */
export interface KimiCliUsageWindow {
  id: "limit5h" | "limit7d" | "monthTotal" | "monthCode";
  usedRatio: number | null;
  /** Unix milliseconds. Null when absent or invalid. */
  resetsAt: number | null;
}

export interface KimiCliUsageSnapshot {
  connected: boolean;
  port: number | null;
  state: "disconnected" | "ready" | "unavailable";
  reason: "request" | "unsupported" | "unsafe" | "accountChanged" | "serverChanged" | null;
  /** Receipt time only. The API has no measurement timestamp or atomic account binding. */
  checkedAt: number | null;
  retryAt: number;
  windows: KimiCliUsageWindow[];
  extraBalanceCents: number | null;
  currency: string | null;
}

export interface ConnectKimiCliUsageInput {
  /** Numeric IPv4 loopback only. Main chooses the host and allowlisted GET routes. */
  port: number;
  token: string;
  /** Explicit consent: these reads may refresh the CLI's existing OAuth sign-in. */
  allowRefresh: true;
}

export const KIMI_CLI_USAGE_FRESH_MS = 120_000;
