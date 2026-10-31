import type { DesktopPlatform, MigrationPreparationState } from "@openbot/contracts/ipc";
import { MigrationAssessmentView } from "@openbot/ui/features/migration/MigrationAssessmentView";
import { createMemo, onSettled } from "solid-js";
import { type MigrationAssessmentCalls, migrationAssessmentPort } from "./migration-assessment-port";
import { createMigrationAssessmentStore } from "./migration-assessment-store";

export function ServerMigrationAssessmentPanel(props: {
  preparationState: MigrationPreparationState;
  platform: DesktopPlatform;
  calls?: MigrationAssessmentCalls | undefined;
}) {
  const canAssess = () => props.platform !== "win32";
  const store = createMigrationAssessmentStore(
    props.calls ?? migrationAssessmentPort(),
    () => props.preparationState,
    canAssess,
  );
  const ready = createMemo(() => store.state.ready && store.preparationMatches());
  const preparationChanged = createMemo(() => store.state.ready && !store.preparationMatches());
  onSettled(() => {
    store.reload();
    return store.dispose;
  });
  return (
    <MigrationAssessmentView
      state={store.state.value}
      declaration={store.state.declaration}
      ready={ready()}
      preparationChanged={preparationChanged()}
      canAssess={canAssess()}
      busy={store.state.busy}
      error={store.state.error}
      validationError={store.state.validationError}
      onDeclarationChange={store.setDeclaration}
      onAssess={store.assess}
      onReload={store.reload}
    />
  );
}
