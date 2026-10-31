import {
  decodeMigrationPreparationState,
  type MigrationPreparationCancelInput,
  type MigrationPreparationPrepareInput,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";

export type MigrationPreparationStoryRequest =
  | { method: "getState" }
  | { method: "prepare"; input: MigrationPreparationPrepareInput }
  | { method: "cancel"; input: MigrationPreparationCancelInput };

declare global {
  interface Window {
    /** Installed only by the synthetic browser acceptance harness. */
    __openbotMigrationPreparationInvoke?: (request: MigrationPreparationStoryRequest) => Promise<unknown>;
  }
}

/** Story-only bridge to the harness's production coordinator with a synthetic database. */
export function injectedMigrationPreparationCalls(): OpenBotDesktopApi["migrationPreparation"] | undefined {
  const invoke = window.__openbotMigrationPreparationInvoke;
  if (!invoke) return undefined;
  return {
    getState: async () => decodeMigrationPreparationState(await invoke({ method: "getState" })),
    prepare: async (input) => decodeMigrationPreparationState(await invoke({ method: "prepare", input })),
    cancel: async (input) => decodeMigrationPreparationState(await invoke({ method: "cancel", input })),
  };
}
