import {
  type MigrationPreparationCancelInput,
  type MigrationPreparationPrepareInput,
  type MigrationPreparationState,
  parseMigrationPreparationCancelInput,
  parseMigrationPreparationPrepareInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

interface MigrationPreparationIpcService<E> {
  getState: () => Effect.Effect<MigrationPreparationState, E>;
  prepare: (input: MigrationPreparationPrepareInput) => Effect.Effect<MigrationPreparationState, E>;
  cancel: (input: MigrationPreparationCancelInput) => Effect.Effect<MigrationPreparationState, E>;
}

export interface MigrationPreparationIpcDependencies<E> {
  migrationPreparation: MigrationPreparationIpcService<E>;
}

/** Local preparation only. The trusted binder validates the sender before these decoders run. */
export function migrationPreparationIpcHandlers<E>({
  migrationPreparation,
}: MigrationPreparationIpcDependencies<E>): Pick<IpcGroupHandlers, "migrationPreparation"> {
  const run = (operation: Effect.Effect<MigrationPreparationState, E>) =>
    Effect.runPromise(
      operation.pipe(Effect.catchCause(() => Effect.fail(new Error(sourceText("error.migration.preparationFailed"))))),
    );
  return {
    migrationPreparation: {
      getState: payloadHandler(
        (value) => {
          if (value !== undefined) throw new Error("Migration preparation state accepts no payload.");
          return undefined;
        },
        () => run(migrationPreparation.getState()),
      ),
      prepare: payloadHandler(parseMigrationPreparationPrepareInput, (input) =>
        run(migrationPreparation.prepare(input)),
      ),
      cancel: payloadHandler(parseMigrationPreparationCancelInput, (input) => run(migrationPreparation.cancel(input))),
    },
  };
}
