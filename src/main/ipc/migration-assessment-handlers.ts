import {
  type MigrationAssessmentAssessInput,
  type MigrationAssessmentState,
  parseMigrationAssessmentAssessInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

interface MigrationAssessmentIpcService<E> {
  getState: () => Effect.Effect<MigrationAssessmentState, E>;
  assess: (input: MigrationAssessmentAssessInput) => Effect.Effect<MigrationAssessmentState, E>;
}
export interface MigrationAssessmentIpcDependencies<E> {
  migrationAssessment: MigrationAssessmentIpcService<E>;
}

/** Local offline assessment only; the trusted binder checks the sender before decoding input. */
export function migrationAssessmentIpcHandlers<E>({
  migrationAssessment,
}: MigrationAssessmentIpcDependencies<E>): Pick<IpcGroupHandlers, "migrationAssessment"> {
  const run = (operation: Effect.Effect<MigrationAssessmentState, E>) =>
    Effect.runPromise(
      operation.pipe(Effect.catchCause(() => Effect.fail(new Error(sourceText("error.migration.assessmentFailed"))))),
    );
  return {
    migrationAssessment: {
      getState: payloadHandler(
        (value) => {
          if (value !== undefined) throw new Error("Migration assessment state accepts no payload.");
          return undefined;
        },
        () => run(migrationAssessment.getState()),
      ),
      assess: payloadHandler(parseMigrationAssessmentAssessInput, (input) => run(migrationAssessment.assess(input))),
    },
  };
}
