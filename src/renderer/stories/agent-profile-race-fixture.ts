import type { AvatarImageInput, ClientAgentSummary, UpdateAgentInput } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";

/** Optional host fields that these synthetic response cases explicitly remove. */
export type AgentProfileReplyRemoval = "providerAccountId" | "pendingRuntime" | "usageLimitReturn";

/** Only mounted by the synthetic response-order story. No production entry point imports it. */
export interface AgentProfileRaceFixture {
  read(): AgentProfile[];
  patchNextReply(patch: Partial<ClientAgentSummary>, remove?: readonly AgentProfileReplyRemoval[]): void;
  arm(kind: "update" | "avatar", mode: "hold" | "reject" | "hold-error"): void;
  held(): number[];
  release(id: number): void;
  jobs(): { id: number; state: "pending" | "fulfilled" | "rejected" }[];
  startUpdate(agentId: string, updates: Omit<UpdateAgentInput, "agentId">, report?: boolean): number;
  startAvatar(agentId: string, image: AvatarImageInput | null, report?: boolean): number;
  select(agentId: string): void;
  mount(): { id: number; serverId: string; settled: boolean };
  serverId(): string;
  switchServer(id: string): Promise<boolean>;
  hideUndo(agentId: string): void;
  remove(agentId: string): Promise<void>;
  errors(): number;
  setEventsEnabled(enabled: boolean): void;
  reload(): Promise<void>;
  remoteRouting(input: UpdateAgentInput): Promise<{
    calls: string[];
    planCards: { agentId: string; enabled: boolean }[];
    rejected: boolean;
    forwarded: UpdateAgentInput | null;
  }>;
  receipts(): { updates: number; avatars: number; removals: number; events: number };
}
declare global {
  interface Window {
    __agentProfileRace: AgentProfileRaceFixture;
  }
}
