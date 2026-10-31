import {
  MIGRATION_PREPARATION_DESTINATIONS,
  type MigrationPreparationBlocker,
  type MigrationPreparationDestinationKind,
  type MigrationPreparationInventory,
  type MigrationPreparationState,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertTitle,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
} from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";

const destinations: MigrationPreparationDestinationKind[] = [...MIGRATION_PREPARATION_DESTINATIONS];
const DESTINATION_KEYS = {
  "local-desktop": "migrationPreparation.destination.local-desktop",
  "docker-host": "migrationPreparation.destination.docker-host",
  "other-server": "migrationPreparation.destination.other-server",
} as const satisfies Record<MigrationPreparationDestinationKind, AppTextKey>;
const BLOCKER_KEYS = {
  "destination-unconfigured": "migrationPreparation.blockers.destination-unconfigured",
  "snapshot-unavailable": "migrationPreparation.blockers.snapshot-unavailable",
  "credentials-unavailable": "migrationPreparation.blockers.credentials-unavailable",
  "fencing-unavailable": "migrationPreparation.blockers.fencing-unavailable",
  "restore-unavailable": "migrationPreparation.blockers.restore-unavailable",
  "activation-unavailable": "migrationPreparation.blockers.activation-unavailable",
} as const satisfies Record<MigrationPreparationBlocker, AppTextKey>;
const COUNT_KEYS = {
  agents: "migrationPreparation.counts.agents",
  conversations: "migrationPreparation.counts.conversations",
  messages: "migrationPreparation.counts.messages",
  attachments: "migrationPreparation.counts.attachments",
  routines: "migrationPreparation.counts.routines",
} as const satisfies Record<keyof MigrationPreparationInventory, AppTextKey>;
const inventoryFields: (keyof MigrationPreparationInventory)[] = [
  "agents",
  "conversations",
  "messages",
  "attachments",
  "routines",
];

export interface MigrationPreparationViewProps {
  state: MigrationPreparationState | null;
  destinationKind: MigrationPreparationDestinationKind;
  ready: boolean;
  busy: "loading" | "preparing" | "cancelling" | null;
  error: string | null;
  onDestinationChange: (value: MigrationPreparationDestinationKind) => void;
  onPrepare: () => void;
  onCancel: () => void;
  onReload: () => void;
}

/** A saved metadata plan. No transfer or activation action is available from this view. */
export function MigrationPreparationView(props: MigrationPreparationViewProps) {
  const { t, format } = useText();
  const plan = () => props.state?.plan;
  const prepared = () => plan()?.status === "prepared";
  const destinationLabel = (value: MigrationPreparationDestinationKind | undefined) =>
    value === undefined ? "" : t(DESTINATION_KEYS[value]);

  return (
    <SettingsSection
      title={t("migrationPreparation.title")}
      description={t("migrationPreparation.description")}
      aria-busy={props.busy ? "true" : undefined}
    >
      <Show when={props.error}>
        {(error) => (
          <Alert tone="danger" role="alert" report={false}>
            <AlertContent>
              <AlertDescription>{error()}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </Show>
      <ItemGroup class="settings-modal-card">
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("migrationPreparation.destination.label")}</ItemTitle>
            <ItemDescription>{t("migrationPreparation.destination.description")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select<MigrationPreparationDestinationKind>
              class="settings-modal-select"
              options={destinations}
              value={props.destinationKind}
              disabled={Boolean(props.busy) || !props.ready || prepared()}
              onChange={(value) => value && props.onDestinationChange(value)}
              itemComponent={(item) => <SelectItem item={item.item}>{destinationLabel(item.item.rawValue)}</SelectItem>}
            >
              <SelectTrigger size="sm" aria-label={t("migrationPreparation.destination.label")}>
                <SelectValue<MigrationPreparationDestinationKind>>
                  {(state) => destinationLabel(state.selectedOption())}
                </SelectValue>
              </SelectTrigger>
              <SelectContent />
            </Select>
          </ItemActions>
        </Item>
      </ItemGroup>
      <div class="agent-import-actions">
        <Show when={!prepared()}>
          <Button
            type="button"
            disabled={!props.ready || Boolean(props.busy)}
            loading={props.busy === "preparing"}
            loadingLabel={t("migrationPreparation.preparing")}
            onClick={props.onPrepare}
          >
            {plan()?.status === "cancelled" ? t("migrationPreparation.newPlan") : t("migrationPreparation.prepare")}
          </Button>
        </Show>
        <Show when={prepared()}>
          <Button
            type="button"
            variant="outline"
            disabled={!props.ready || Boolean(props.busy)}
            loading={props.busy === "cancelling"}
            loadingLabel={t("migrationPreparation.cancelling")}
            onClick={props.onCancel}
          >
            {t("migrationPreparation.cancel")}
          </Button>
        </Show>
        <Button
          type="button"
          variant="outline"
          disabled={Boolean(props.busy)}
          loading={props.busy === "loading"}
          loadingLabel={t("migrationPreparation.loading")}
          onClick={props.onReload}
        >
          {t("migrationPreparation.reload")}
        </Button>
      </div>
      <Show when={plan()}>
        {(saved) => (
          <>
            <Alert tone="neutral" role="status">
              <AlertContent>
                <AlertTitle>
                  {saved().status === "prepared"
                    ? t("migrationPreparation.status.prepared")
                    : t("migrationPreparation.status.cancelled")}
                </AlertTitle>
                <AlertDescription>
                  {t("migrationPreparation.savedDestination")}: {destinationLabel(saved().destinationKind)}
                </AlertDescription>
                <AlertDescription>
                  {t("migrationPreparation.updatedAt")}:{" "}
                  {format.date(new Date(saved().updatedAt), { dateStyle: "medium", timeStyle: "short" })}
                </AlertDescription>
              </AlertContent>
            </Alert>
            <SettingsSection
              title={t("migrationPreparation.provisionalInventory")}
              description={t("migrationPreparation.metadataOnly")}
            >
              <ItemGroup class="settings-modal-card">
                <For each={inventoryFields}>
                  {(field) => (
                    <Item class="settings-modal-row">
                      <ItemContent>
                        <ItemTitle>{t(COUNT_KEYS[field])}</ItemTitle>
                      </ItemContent>
                      <ItemActions>{format.number(saved().inventory[field])}</ItemActions>
                    </Item>
                  )}
                </For>
              </ItemGroup>
            </SettingsSection>
            <SettingsSection title={t("migrationPreparation.blockers.title")}>
              <ItemGroup class="settings-modal-card">
                <For each={saved().blockers}>
                  {(blocker) => (
                    <Item class="settings-modal-row">
                      <ItemContent>
                        <ItemDescription>{t(BLOCKER_KEYS[blocker])}</ItemDescription>
                      </ItemContent>
                    </Item>
                  )}
                </For>
              </ItemGroup>
            </SettingsSection>
          </>
        )}
      </Show>
      <SettingsSection description={t("migrationPreparation.unavailable")} title={t("migrationPreparation.actions")}>
        <div class="agent-import-actions">
          <Button type="button" variant="outline" disabled>
            {t("migrationPreparation.export")}
          </Button>
          <Button type="button" variant="outline" disabled>
            {t("migrationPreparation.restore")}
          </Button>
          <Button type="button" variant="outline" disabled>
            {t("migrationPreparation.activate")}
          </Button>
        </div>
      </SettingsSection>
    </SettingsSection>
  );
}
