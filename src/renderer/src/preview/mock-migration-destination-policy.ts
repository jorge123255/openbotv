import type { MigrationPreparationState, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import {
  decodeMigrationDestinationPolicyState,
  MIGRATION_DESTINATION_POLICY,
  MIGRATION_DESTINATION_POLICY_UNAVAILABLE,
} from "@openbot/contracts/ipc-migration-destination-policy";
import { MIGRATION_PREPARATION_BLOCKERS } from "@openbot/contracts/ipc-migration-preparation";

/** Reads the current preview preparation lazily. No build or destination evidence is fabricated. */
export function createMockMigrationDestinationPolicy(
  readPreparation: () => Promise<MigrationPreparationState>,
): OpenBotDesktopApi["migrationDestinationPolicy"] {
  return {
    getState: async () => {
      const before = await readPreparation();
      const after = await readPreparation();
      const plan = after.plan;
      const changed =
        before.revision !== after.revision || before.plan?.id !== plan?.id || before.plan?.status !== plan?.status;
      const applicable = plan?.status === "prepared" && plan.destinationKind === "docker-host";
      return decodeMigrationDestinationPolicyState({
        policy: MIGRATION_DESTINATION_POLICY,
        approvedReleaseTag: null,
        preparation: plan
          ? { planId: plan.id, revision: after.revision, status: plan.status, destinationKind: plan.destinationKind }
          : null,
        applicability: changed ? "stale" : applicable ? "current" : "none",
        phase: applicable ? "blocked" : "out-of-scope",
        unavailable: [...MIGRATION_DESTINATION_POLICY_UNAVAILABLE],
        evidence: {
          releaseApproved: false,
          provenanceVerified: false,
          runtimeBound: false,
          pairingApproved: false,
          sourceAuthenticated: false,
        },
        blockers: [...MIGRATION_PREPARATION_BLOCKERS],
        destinationVerified: false,
        inventoryComplete: false,
        operations: { export: false, restore: false, activate: false },
      });
    },
  };
}
