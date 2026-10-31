import { randomUUID } from "node:crypto";
import {
  MIGRATION_ASSESSMENT_MAX_REVISION,
  type MigrationAssessmentAssessInput,
  type MigrationAssessmentInventory,
  type MigrationAssessmentPreparationLink,
  type MigrationAssessmentSource,
  type MigrationAssessmentState,
} from "@openbot/contracts/ipc-migration-assessment";
import {
  MIGRATION_PREPARATION_BLOCKERS,
  type MigrationPreparationState,
} from "@openbot/contracts/ipc-migration-preparation";
import { Effect } from "effect";
import type { MigrationAssessmentInventoryFailure } from "./migration-assessment-inventory";
import { assessMigrationDeclaration } from "./migration-assessment-policy";
import {
  MigrationAssessmentFailure,
  MigrationAssessmentStore,
  type StoredMigrationAssessment,
} from "./migration-assessment-store";
import type { MigrationPreparationFailure } from "./migration-preparation";

interface PreparationReader {
  getState: () => Effect.Effect<MigrationPreparationState, MigrationPreparationFailure>;
}
export interface MigrationAssessmentOptions {
  userDataPath: string;
  preparation: PreparationReader;
  readSource: () => Effect.Effect<Omit<MigrationAssessmentSource, "schemaVersion">, MigrationAssessmentFailure>;
  readInventory: () => Effect.Effect<MigrationAssessmentInventory, MigrationAssessmentInventoryFailure>;
  now?: () => string;
}

function link(state: MigrationPreparationState): MigrationAssessmentPreparationLink | null {
  return state.plan ? { planId: state.plan.id, revision: state.revision, status: state.plan.status } : null;
}
function result(preparation: MigrationPreparationState, stored: StoredMigrationAssessment): MigrationAssessmentState {
  const current = link(preparation);
  return {
    preparation: current,
    revision: stored.revision,
    applicability: !stored.assessment
      ? "none"
      : current?.status === "prepared" &&
          current.planId === stored.assessment.planId &&
          current.revision === stored.assessment.preparationRevision
        ? "current"
        : "stale",
    assessment: stored.assessment,
  };
}

/** Owns informational assessments only; the preparation and assessment journals are not one transaction. */
export class MigrationAssessmentService {
  readonly #store: MigrationAssessmentStore;
  readonly #options: MigrationAssessmentOptions;
  constructor(options: MigrationAssessmentOptions) {
    this.#store = new MigrationAssessmentStore(options.userDataPath);
    this.#options = options;
  }

  readonly #readPreparation = Effect.fn("MigrationAssessment.readPreparation")(() =>
    Effect.suspend(() => this.#options.preparation.getState()).pipe(
      Effect.mapError(() => new MigrationAssessmentFailure({ code: "preparation-unavailable" })),
      Effect.catchDefect(() => Effect.fail(new MigrationAssessmentFailure({ code: "preparation-unavailable" }))),
    ),
  );

  readonly getState = Effect.fn("MigrationAssessment.getState")(() =>
    Effect.gen({ self: this }, function* () {
      const before = yield* this.#readPreparation();
      if (!before.plan) return result(before, { revision: 0, assessment: null });
      const stored = yield* this.#store.read(before.plan.id);
      const after = yield* this.#readPreparation();
      return result(after, stored);
    }),
  );

  readonly assess = Effect.fn("MigrationAssessment.assess")((input: MigrationAssessmentAssessInput) =>
    Effect.gen({ self: this }, function* () {
      const before = yield* this.#readPreparation();
      if (before.plan?.status !== "prepared")
        return yield* new MigrationAssessmentFailure({ code: "preparation-unavailable" });
      if (before.plan.id !== input.planId || before.revision !== input.expectedPreparationRevision)
        return yield* new MigrationAssessmentFailure({ code: "preparation-changed" });
      const observed = yield* this.#store.read(input.planId);
      if (observed.revision !== input.expectedAssessmentRevision)
        return yield* new MigrationAssessmentFailure({ code: "revision-conflict" });
      if (observed.revision >= MIGRATION_ASSESSMENT_MAX_REVISION)
        return yield* new MigrationAssessmentFailure({ code: "assessment-limit" });
      const inventory = yield* Effect.suspend(() => this.#options.readInventory()).pipe(
        Effect.mapError(() => new MigrationAssessmentFailure({ code: "inventory-unavailable" })),
        Effect.catchDefect(() => Effect.fail(new MigrationAssessmentFailure({ code: "inventory-unavailable" }))),
      );
      const identity = yield* Effect.suspend(() => this.#options.readSource()).pipe(
        Effect.mapError(() => new MigrationAssessmentFailure({ code: "source-unavailable" })),
        Effect.catchDefect(() => Effect.fail(new MigrationAssessmentFailure({ code: "source-unavailable" }))),
      );
      const source = { ...identity, schemaVersion: inventory.schema.observedVersion };
      const report = {
        id: randomUUID(),
        revision: input.expectedAssessmentRevision + 1,
        planId: input.planId,
        preparationRevision: input.expectedPreparationRevision,
        createdAt: (this.#options.now ?? (() => new Date().toISOString()))(),
        targetKind: before.plan.destinationKind,
        provenance: "offline-declaration" as const,
        source,
        destination: input.destination,
        ...assessMigrationDeclaration(source, input.destination, before.plan.destinationKind, inventory),
        inventory,
        destinationVerified: false as const,
        inventoryComplete: false as const,
        blockers: [...MIGRATION_PREPARATION_BLOCKERS],
        operations: { export: false as const, restore: false as const, activate: false as const },
      };
      const checked = yield* this.#readPreparation();
      if (
        checked.plan?.id !== input.planId ||
        checked.plan.status !== "prepared" ||
        checked.revision !== input.expectedPreparationRevision
      )
        return yield* new MigrationAssessmentFailure({ code: "preparation-changed" });
      const stored = yield* this.#store.append(input.expectedAssessmentRevision, report);
      const after = yield* this.#readPreparation();
      return result(after, stored);
    }),
  );
}
