import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type MigrationPreparationCalls = OpenBotDesktopApi["migrationPreparation"];

/** This bridge has no server argument. It serves only the current local instance. */
export function migrationPreparationPort(): MigrationPreparationCalls {
  return window.openbot.migrationPreparation;
}
