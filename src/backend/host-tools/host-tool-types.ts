import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import type { HostToolAction } from "./host-tool-policy";

export interface HostToolRequest {
  readonly id: string;
  readonly action: HostToolAction;
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly machineId?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly isBackground?: boolean;
  readonly path?: string;
  readonly fileText?: string;
  readonly chars?: string;
  readonly shellId?: number;
  readonly serverIdentifier?: string;
  readonly providerIdentifier?: string;
  readonly toolName?: string;
  readonly arguments?: DynamicRecord;
}

export interface ListedMachine {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
}

export interface HostToolRow {
  readonly id: string;
  readonly action: HostToolAction;
  readonly status: "completed" | "failed";
  readonly text: string;
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly path?: string;
  readonly thumbnailPath?: string;
}
