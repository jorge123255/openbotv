import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { decodeMigrationDestinationPolicyState } from "@openbot/contracts/ipc-migration-destination-policy";

export type MigrationDestinationPolicyStoryRequest = { method: "getState" };

declare global {
  interface Window {
    /** Installed only by the synthetic browser acceptance harness. */
    __openbotMigrationDestinationPolicyInvoke?: (request: MigrationDestinationPolicyStoryRequest) => Promise<unknown>;
  }
}

/** Story-only bridge to the actual policy service over an owned generated profile. */
export function injectedMigrationDestinationPolicyCalls(): OpenBotDesktopApi["migrationDestinationPolicy"] | undefined {
  const invoke = window.__openbotMigrationDestinationPolicyInvoke;
  if (!invoke) return undefined;
  return { getState: async () => decodeMigrationDestinationPolicyState(await invoke({ method: "getState" })) };
}
