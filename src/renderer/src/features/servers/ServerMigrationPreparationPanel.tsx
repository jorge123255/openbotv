import type { DesktopPlatform } from "@openbot/contracts/ipc";
import { MigrationPreparationView } from "@openbot/ui/features/migration/MigrationPreparationView";
import { onSettled } from "solid-js";
import { type MigrationPreparationCalls, migrationPreparationPort } from "./migration-preparation-port";
import { createMigrationPreparationStore } from "./migration-preparation-store";

export interface ServerMigrationPreparationOptions {
  calls?: MigrationPreparationCalls;
}

/** This computer only. There is no remote migration capability. */
export function ServerMigrationPreparationPanel(
  props: ServerMigrationPreparationOptions & { platform: DesktopPlatform },
) {
  const canPrepare = () => props.platform !== "win32";
  const store = createMigrationPreparationStore(props.calls ?? migrationPreparationPort(), canPrepare);
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
    />
  );
}
