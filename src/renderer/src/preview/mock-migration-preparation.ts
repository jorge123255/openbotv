import {
  decodeMigrationPreparationState,
  MIGRATION_PREPARATION_BLOCKERS,
  MIGRATION_PREPARATION_MAX_COUNT,
  type MigrationPreparationInventory,
  type MigrationPreparationState,
  type OpenBotDesktopApi,
  parseMigrationPreparationCancelInput,
  parseMigrationPreparationPrepareInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";

/** One preview instance retains preparation state across panel reloads, with revision conflicts. */
export function createMockMigrationPreparation(
  inventory: () => MigrationPreparationInventory,
): OpenBotDesktopApi["migrationPreparation"] {
  let state: MigrationPreparationState = { revision: 0, plan: null };
  const fail = (): never => {
    throw new Error(sourceText("error.migration.preparationFailed"));
  };
  const snapshot = () => decodeMigrationPreparationState(state);
  const checkRevision = (expected: number) => {
    if (expected !== state.revision || state.revision >= MIGRATION_PREPARATION_MAX_COUNT) fail();
  };
  return {
    getState: async () => snapshot(),
    prepare: async (value) => {
      const input = parseMigrationPreparationPrepareInput(value);
      checkRevision(input.expectedRevision);
      if (state.plan?.status === "prepared") fail();
      const now = new Date().toISOString();
      const next = decodeMigrationPreparationState({
        revision: state.revision + 1,
        plan: {
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
          status: "prepared",
          destinationKind: input.destinationKind,
          inventory: inventory(),
          observation: "metadata-only",
          blockers: [...MIGRATION_PREPARATION_BLOCKERS],
          operations: { export: false, restore: false, activate: false },
        },
      });
      state = next;
      return snapshot();
    },
    cancel: async (value) => {
      const input = parseMigrationPreparationCancelInput(value);
      checkRevision(input.expectedRevision);
      if (!state.plan || state.plan.id !== input.planId || state.plan.status !== "prepared") return fail();
      state = {
        revision: state.revision + 1,
        plan: {
          ...state.plan,
          status: "cancelled",
          updatedAt: new Date(Math.max(Date.now(), Date.parse(state.plan.updatedAt))).toISOString(),
        },
      };
      return snapshot();
    },
  };
}
