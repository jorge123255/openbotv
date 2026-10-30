import type { AgentProviderId, GrokBotUsageSummary } from "@openbot/contracts/ipc";
import { type PlanLimitTone, usageRemainingPercent, usageTone } from "@openbot/team-client/plan-limits";

export const GROK_BOT_USAGE_ACCOUNT_ID = "grok-bot";

interface UsageLabel {
  label: string;
  remainingPercent: number;
  tone: PlanLimitTone;
  resetsAt: number | null;
  resetsAtLabel: string | null;
}

export interface GrokBotUsageRow {
  provider: AgentProviderId;
  accountId: string | null;
  name: string;
  remainingPercent: number | null;
  tone: PlanLimitTone;
  windows: UsageLabel[];
  ringWindows: UsageLabel[];
  reportsUsage: boolean;
  sharedQuotaWith: AgentProviderId | null;
  changeLimit?: boolean;
}

export interface GrokBotUsageLabels {
  name: string;
  included: string;
  onDemand: string;
  formatReset: (date: Date) => string;
}

/** A rail row for the Grok Bot account. It is not the Cursor provider row. */
export function grokBotUsageRow(summary: GrokBotUsageSummary, labels: GrokBotUsageLabels): GrokBotUsageRow | null {
  if (summary.includedUsedPercent === null && summary.onDemand === null) return null;
  const windowRow = (usedPercent: number, label: string, resetsAt: number | null): UsageLabel => {
    const remainingPercent = usageRemainingPercent(usedPercent);
    return {
      label,
      remainingPercent,
      tone: usageTone(remainingPercent),
      resetsAt,
      resetsAtLabel: formatReset(resetsAt, labels),
    };
  };
  const windows: UsageLabel[] = [];
  if (!summary.enterprise && summary.includedUsedPercent !== null) {
    windows.push(windowRow(summary.includedUsedPercent, labels.included, summary.includedResetsAt));
  }
  if (summary.onDemand) {
    windows.push(windowRow(summary.onDemand.usedPercent, labels.onDemand, summary.onDemand.resetsAt));
  }
  const remaining = windows.reduce<number | null>(
    (lowest, window) => (lowest === null ? window.remainingPercent : Math.min(lowest, window.remainingPercent)),
    null,
  );
  return {
    provider: "grok",
    accountId: GROK_BOT_USAGE_ACCOUNT_ID,
    name: labels.name,
    remainingPercent: remaining,
    tone: usageTone(remaining ?? 100),
    windows,
    ringWindows: windows,
    reportsUsage: true,
    sharedQuotaWith: null,
    changeLimit: summary.changeLimit,
  };
}

function formatReset(resetsAt: number | null, labels: GrokBotUsageLabels): string | null {
  if (resetsAt === null) return null;
  const date = new Date(resetsAt * 1_000);
  if (Number.isNaN(date.getTime())) return null;
  return labels.formatReset(date);
}
