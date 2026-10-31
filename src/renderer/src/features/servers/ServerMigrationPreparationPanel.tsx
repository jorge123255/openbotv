import type { DesktopPlatform } from "@openbot/contracts/ipc";
import { MigrationPreparationView } from "@openbot/ui/features/migration/MigrationPreparationView";
import { createMemo, onSettled, Show } from "solid-js";
import type { MigrationAssessmentCalls } from "./migration-assessment-port";
import { type MigrationPreparationCalls, migrationPreparationPort } from "./migration-preparation-port";
import { createMigrationPreparationStore } from "./migration-preparation-store";
import { ServerMigrationAssessmentPanel } from "./ServerMigrationAssessmentPanel";

export interface ServerMigrationPreparationOptions {
  calls?: MigrationPreparationCalls;
  assessmentCalls?: MigrationAssessmentCalls | undefined;
}

/** This computer only. There is no remote migration capability. */
export function ServerMigrationPreparationPanel(
  props: ServerMigrationPreparationOptions & { platform: DesktopPlatform },
) {
  const canPrepare = () => props.platform !== "win32";
  const store = createMigrationPreparationStore(props.calls ?? migrationPreparationPort(), canPrepare);
  const assessmentPreparation = createMemo(() =>
    store.state.value?.plan?.status === "prepared" ? store.state.value : null,
  );
  onSettled(() => {
    store.reload();
    return store.dispose;
  });
  return (
    <MigrationPreparationView
      state={store.state.value}
      destinationKind={store.state.destinationKind}
      ready={store.state.ready}
      canPrepare={canPrepare()}
      busy={store.state.busy}
      error={store.state.error}
      onDestinationChange={store.setDestination}
      onPrepare={store.prepare}
      onCancel={store.cancel}
      onReload={store.reload}
      assessment={
        <Show when={assessmentPreparation()}>
          {(preparation) => (
            <ServerMigrationAssessmentPanel
              preparationState={preparation()}
              platform={props.platform}
              calls={props.assessmentCalls}
            />
          )}
        </Show>
      }
    />
  );
}
