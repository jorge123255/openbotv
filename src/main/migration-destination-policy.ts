import {
  MIGRATION_DESTINATION_POLICY,
  MIGRATION_DESTINATION_POLICY_UNAVAILABLE,
  type MigrationDestinationPolicyPreparation,
  type MigrationDestinationPolicyState,
} from "@openbot/contracts/ipc-migration-destination-policy";
import {
  MIGRATION_PREPARATION_BLOCKERS,
  type MigrationPreparationState,
} from "@openbot/contracts/ipc-migration-preparation";
import { Effect, Schema } from "effect";
import type { MigrationPreparationFailure } from "./migration-preparation";

export class MigrationDestinationPolicyFailure extends Schema.TaggedError<MigrationDestinationPolicyFailure>()(
  "MigrationDestinationPolicyFailure",
  { code: Schema.Literals(["preparation-unavailable", "unsupported-platform"]) },
) {}
interface MigrationDestinationPolicyOptions {
  preparation: { getState: () => Effect.Effect<MigrationPreparationState, MigrationPreparationFailure> };
  platform?: () => NodeJS.Platform;
}
function binding(state: MigrationPreparationState): MigrationDestinationPolicyPreparation | null {
  return state.plan
    ? {
        planId: state.plan.id,
        revision: state.revision,
        status: state.plan.status,
        destinationKind: state.plan.destinationKind,
      }
    : null;
}

/** Approved policy availability only. No evidence input, trust issuance, tag approval, writes or remote operation. */
export class MigrationDestinationPolicyService {
  readonly #options: MigrationDestinationPolicyOptions;
  constructor(options: MigrationDestinationPolicyOptions) {
    this.#options = options;
  }

  readonly #preparation = Effect.fn("MigrationDestinationPolicy.preparation")(() =>
    Effect.suspend(() => this.#options.preparation.getState()).pipe(
      Effect.mapError(() => new MigrationDestinationPolicyFailure({ code: "preparation-unavailable" })),
      Effect.catchDefect(() => Effect.fail(new MigrationDestinationPolicyFailure({ code: "preparation-unavailable" }))),
    ),
  );

  readonly getState = Effect.fn("MigrationDestinationPolicy.getState")(() =>
    Effect.gen({ self: this }, function* () {
      const platform = (this.#options.platform ?? (() => process.platform))();
      if (platform !== "darwin" && platform !== "linux")
        return yield* new MigrationDestinationPolicyFailure({ code: "unsupported-platform" });
      const before = binding(yield* this.#preparation());
      const after = binding(yield* this.#preparation());
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      const applicable = after?.status === "prepared" && after.destinationKind === "docker-host";
      const state: MigrationDestinationPolicyState = {
        policy: MIGRATION_DESTINATION_POLICY,
        approvedReleaseTag: null,
        preparation: after,
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
      };
      return state;
    }),
  );
}
