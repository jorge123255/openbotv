import type { MigrationDestinationPolicyState } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

interface MigrationDestinationPolicyIpcDependencies<E> {
  migrationDestinationPolicy: { getState: () => Effect.Effect<MigrationDestinationPolicyState, E> };
}

/** Trusted no-argument status. The renderer cannot supply a release tag, evidence, target or credential. */
export function migrationDestinationPolicyIpcHandlers<E>({
  migrationDestinationPolicy,
}: MigrationDestinationPolicyIpcDependencies<E>): Pick<IpcGroupHandlers, "migrationDestinationPolicy"> {
  return {
    migrationDestinationPolicy: {
      getState: payloadHandler(
        (value) => {
          if (value !== undefined) throw new Error("Migration destination policy accepts no payload.");
          return undefined;
        },
        () =>
          Effect.runPromise(
            migrationDestinationPolicy
              .getState()
              .pipe(
                Effect.catchCause(() =>
                  Effect.fail(new Error(sourceText("error.migration.destinationPolicyReadFailed"))),
                ),
              ),
          ),
      ),
    },
  };
}
