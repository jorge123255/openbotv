import {
  decodeMigrationAssessmentState,
  type MigrationAssessmentAssessInput,
  type OpenBotDesktopApi,
} from "@openbot/contracts/ipc";

export type MigrationAssessmentStoryRequest =
  | { method: "getState" }
  | { method: "assess"; input: MigrationAssessmentAssessInput };

declare global {
  interface Window {
    /** Installed only by the synthetic browser acceptance harness. */
    __openbotMigrationAssessmentInvoke?: (request: MigrationAssessmentStoryRequest) => Promise<unknown>;
  }
}

/** Story-only bridge; the harness owns its synthetic database and real coordinator. */
export function injectedMigrationAssessmentCalls(): OpenBotDesktopApi["migrationAssessment"] | undefined {
  const invoke = window.__openbotMigrationAssessmentInvoke;
  if (!invoke) return undefined;
  return {
    getState: async () => decodeMigrationAssessmentState(await invoke({ method: "getState" })),
    assess: async (input) => decodeMigrationAssessmentState(await invoke({ method: "assess", input })),
  };
}
