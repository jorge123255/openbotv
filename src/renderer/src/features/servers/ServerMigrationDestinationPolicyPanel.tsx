import type { DesktopPlatform, MigrationPreparationState } from "@openbot/contracts/ipc";
import { MigrationDestinationPolicyView } from "@openbot/ui/features/migration/MigrationDestinationPolicyView";
import { createMemo, onSettled, untrack } from "solid-js";
import {
  type MigrationDestinationPolicyCalls,
  migrationDestinationPolicyPort,
} from "./migration-destination-policy-port";
import { createMigrationDestinationPolicyStore } from "./migration-destination-policy-store";

export function ServerMigrationDestinationPolicyPanel(props: {
  preparationState: MigrationPreparationState;
  platform: DesktopPlatform;
  calls?: MigrationDestinationPolicyCalls | undefined;
}) {
  const available = () => props.platform !== "win32";
  const calls = untrack(() => props.calls ?? migrationDestinationPolicyPort());
  const store = createMigrationDestinationPolicyStore(calls, () => props.preparationState, available);
  const current = createMemo(() => (store.preparationMatches() ? store.state.value : null));
  const stale = createMemo(() => store.state.stale || Boolean(store.state.value && !store.preparationMatches()));
  onSettled(() => {
    store.reload();
    return store.dispose;
  });
  return (
    <MigrationDestinationPolicyView
      state={current()}
      loading={store.state.loading}
      stale={stale()}
      error={store.state.error}
      onReload={store.reload}
    />
  );
}
