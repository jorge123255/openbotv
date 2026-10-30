export interface GrokBotSignInStart {
  readonly verificationUrl: string;
}

export interface GrokBotAgentSummary {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly room: boolean;
}

/** A read-only mirror of Grok Bot agents into local `grok-bot` agents on this computer. */
export interface GrokBotImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly agentIds: readonly string[];
}

export interface CreateGrokBotAgentInput {
  readonly name: string;
  readonly description: string;
}

export interface GrokBotUsageOnDemand {
  readonly usedUsd: number;
  readonly limitUsd: number;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

export interface GrokBotUsageSummary {
  readonly includedUsedPercent: number | null;
  readonly includedResetsAt: number | null;
  readonly hasAvailableUsage: boolean;
  readonly enterprise: boolean;
  readonly trialActive: boolean;
  readonly trialClaim: boolean;
  readonly changeLimit: boolean;
  readonly onDemand: GrokBotUsageOnDemand | null;
}

export type GrokBotAccountEvent =
  | { readonly phase: "signed-in" }
  | { readonly phase: "signed-out" }
  | { readonly phase: "failed"; readonly message: string };
