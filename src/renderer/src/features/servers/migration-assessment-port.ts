import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type MigrationAssessmentCalls = OpenBotDesktopApi["migrationAssessment"];

/** Local metadata assessment only. There is no remote host or destination connection. */
export function migrationAssessmentPort(): MigrationAssessmentCalls {
  return window.openbot.migrationAssessment;
}
