// Local metadata preparation only. This service has no export, restore, execution or host API.
import { randomUUID } from "node:crypto";
import {
  decodeMigrationPreparationState,
  MIGRATION_PREPARATION_BLOCKERS,
  type MigrationPreparationCancelInput,
  type MigrationPreparationInventory,
  type MigrationPreparationPrepareInput,
  type MigrationPreparationState,
} from "@openbot/contracts/ipc-migration-preparation";
import { Effect } from "effect";
import { MigrationPreparationFailure, MigrationPreparationStore } from "./migration-preparation-store";

export { MigrationPreparationFailure } from "./migration-preparation-store";

export interface MigrationPreparationOptions {
  userDataPath: string;
  readInventory: () => Effect.Effect<MigrationPreparationInventory, MigrationPreparationFailure>;
  now?: () => string;
}

export class MigrationPreparationService {
  readonly #store: MigrationPreparationStore;
  readonly #readInventory: MigrationPreparationOptions["readInventory"];
  readonly #now: () => string;

  constructor(options: MigrationPreparationOptions) {
    this.#store = new MigrationPreparationStore(options.userDataPath);
    this.#readInventory = options.readInventory;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  readonly getState = Effect.fn("MigrationPreparation.getState")(() => this.#store.read());

  readonly prepare = Effect.fn("MigrationPreparation.prepare")((input: MigrationPreparationPrepareInput) =>
    Effect.gen({ self: this }, function* () {
      const observed = yield* this.#store.read();
      if (observed.revision !== input.expectedRevision)
        return yield* new MigrationPreparationFailure({ code: "revision-conflict" });
      if (observed.plan?.status === "prepared")
        return yield* new MigrationPreparationFailure({ code: "plan-already-prepared" });
      const inventory = yield* Effect.suspend(() => this.#readInventory()).pipe(
        Effect.mapError(() => new MigrationPreparationFailure({ code: "inventory-unavailable" })),
        Effect.catchDefect(() => Effect.fail(new MigrationPreparationFailure({ code: "inventory-unavailable" }))),
      );
      const prepared = yield* Effect.try({
        try: () => {
          const now = this.#now();
          return decodeMigrationPreparationState({
            revision: input.expectedRevision + 1,
            plan: {
              id: randomUUID(),
              createdAt: now,
              updatedAt: now,
              status: "prepared",
              destinationKind: input.destinationKind,
              inventory,
              observation: "metadata-only",
              blockers: [...MIGRATION_PREPARATION_BLOCKERS],
              operations: { export: false, restore: false, activate: false },
            },
          });
        },
        catch: () => new MigrationPreparationFailure({ code: "inventory-unavailable" }),
      });
      return yield* this.#store.update(input.expectedRevision, (current) => {
        if (current.plan?.status === "prepared")
          throw new MigrationPreparationFailure({ code: "plan-already-prepared" });
        return prepared;
      });
    }),
  );

  readonly cancel = Effect.fn("MigrationPreparation.cancel")((input: MigrationPreparationCancelInput) =>
    this.#store.update(input.expectedRevision, (current): MigrationPreparationState => {
      if (!current.plan || current.plan.id !== input.planId || current.plan.status !== "prepared")
        throw new MigrationPreparationFailure({ code: "plan-mismatch" });
      const now = this.#now();
      if (now < current.plan.createdAt) throw new MigrationPreparationFailure({ code: "invalid-input" });
      return { revision: current.revision + 1, plan: { ...current.plan, status: "cancelled", updatedAt: now } };
    }),
  );
}
