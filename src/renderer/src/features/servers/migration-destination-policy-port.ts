import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type MigrationDestinationPolicyCalls = OpenBotDesktopApi["migrationDestinationPolicy"];

/** Reads local policy status only. It does not connect to a destination. */
export function migrationDestinationPolicyPort(): MigrationDestinationPolicyCalls {
  return window.openbot.migrationDestinationPolicy;
}
