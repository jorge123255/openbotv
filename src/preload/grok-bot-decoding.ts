import type {
  GrokBotAccountEvent,
  GrokBotAgentSummary,
  GrokBotSignInStart,
  GrokBotUsageSummary,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

const SECRET_KEYS = new Set(["accessToken", "refreshToken", "gatewayToken", "verifier"]);

export function decodeGrokBotStatus(value: unknown): { signedIn: boolean } {
  rejectSecrets(value);
  if (!isDynamicRecord(value) || typeof value.signedIn !== "boolean") throw new Error("Invalid Grok Bot response.");
  return { signedIn: value.signedIn };
}

export function decodeGrokBotSignInStart(value: unknown): GrokBotSignInStart {
  rejectSecrets(value);
  if (
    !isDynamicRecord(value) ||
    typeof value.verificationUrl !== "string" ||
    !isCursorLoginUrl(value.verificationUrl)
  ) {
    throw new Error("Invalid Grok Bot response.");
  }
  return { verificationUrl: value.verificationUrl };
}

export function decodeGrokBotAgents(value: unknown): readonly GrokBotAgentSummary[] {
  rejectSecrets(value);
  if (!Array.isArray(value)) throw new Error("Invalid Grok Bot response.");
  return value.map(decodeGrokBotAgent);
}

export function decodeGrokBotAgent(value: unknown): GrokBotAgentSummary {
  rejectSecrets(value);
  if (!isDynamicRecord(value)) throw new Error("Invalid Grok Bot response.");
  return {
    id: textField(value.id),
    name: textField(value.name),
    title: textField(value.title),
    description: textField(value.description),
    hidden: value.hidden === true,
    room: value.room === true,
  };
}

export function decodeGrokBotUsageSummary(value: unknown): GrokBotUsageSummary | null {
  if (value === null) return null;
  rejectUsageSecrets(value);
  if (!isDynamicRecord(value)) throw new Error("Invalid Grok Bot response.");
  const onDemand = value.onDemand;
  return {
    includedUsedPercent: percentField(value.includedUsedPercent),
    includedResetsAt: numberOrNull(value.includedResetsAt),
    hasAvailableUsage: value.hasAvailableUsage === true,
    enterprise: value.enterprise === true,
    trialActive: value.trialActive === true,
    trialClaim: value.trialClaim === true,
    changeLimit: value.changeLimit === true,
    onDemand:
      onDemand === null
        ? null
        : isDynamicRecord(onDemand)
          ? {
              usedUsd: requiredNumber(onDemand.usedUsd),
              limitUsd: requiredNumber(onDemand.limitUsd),
              usedPercent: requiredNumber(onDemand.usedPercent),
              resetsAt: numberOrNull(onDemand.resetsAt),
            }
          : failUsage(),
  };
}

export function decodeGrokBotAccountEvent(value: unknown): GrokBotAccountEvent {
  rejectSecrets(value);
  if (!isDynamicRecord(value)) throw new Error("Invalid Grok Bot response.");
  if (value.phase === "signed-in" || value.phase === "signed-out") return { phase: value.phase };
  if (value.phase === "failed" && typeof value.message === "string") return { phase: "failed", message: value.message };
  throw new Error("Invalid Grok Bot response.");
}

function textField(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Grok Bot response.");
  return value;
}

function isCursorLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "cursor.com";
  } catch {
    return false;
  }
}

function percentField(value: unknown): number | null {
  if (value === null) return null;
  return requiredNumber(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === null) return null;
  return requiredNumber(value);
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) failUsage();
  return value;
}

function failUsage(): never {
  throw new Error("Invalid Grok Bot response.");
}

function rejectUsageSecrets(value: unknown): void {
  const blocked = new Set(["accessToken", "refreshToken", "upgradeRecommendation", "dashboardUrl"]);
  if (!isDynamicRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (blocked.has(key)) throw new Error("Invalid Grok Bot response.");
  }
}

function rejectSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectSecrets(item);
    return;
  }
  if (!isDynamicRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) throw new Error("Invalid Grok Bot response.");
    rejectSecrets(nested);
  }
}
