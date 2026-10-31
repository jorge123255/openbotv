import type { MigrationDestinationPolicyState } from "@openbot/contracts/ipc-migration-destination-policy";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertContent,
  AlertDescription,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
} from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";

const UNAVAILABLE_KEYS = {
  "approved-release-tag-unavailable": "migrationDestinationPolicy.unavailable.approved-release-tag-unavailable",
  "attestation-verifier-unavailable": "migrationDestinationPolicy.unavailable.attestation-verifier-unavailable",
  "runtime-binding-unavailable": "migrationDestinationPolicy.unavailable.runtime-binding-unavailable",
  "pairing-approval-unavailable": "migrationDestinationPolicy.unavailable.pairing-approval-unavailable",
  "source-authentication-unavailable": "migrationDestinationPolicy.unavailable.source-authentication-unavailable",
} as const satisfies Record<MigrationDestinationPolicyState["unavailable"][number], AppTextKey>;

/** Approved scope and missing providers only. No positive verification or migration action. */
export function MigrationDestinationPolicyView(props: {
  state: MigrationDestinationPolicyState | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  onReload: () => void;
}) {
  const { t } = useText();
  return (
    <SettingsSection
      title={t("migrationDestinationPolicy.title")}
      description={t("migrationDestinationPolicy.description")}
      aria-busy={props.loading ? "true" : undefined}
    >
      <Alert tone="neutral" role="status" report={false}>
        <AlertContent>
          <AlertDescription>{t("migrationDestinationPolicy.blocked")}</AlertDescription>
        </AlertContent>
      </Alert>
      <Show when={props.stale}>
        <Alert tone="neutral" role="status" report={false}>
          <AlertContent>
            <AlertDescription>{t("migrationDestinationPolicy.stale")}</AlertDescription>
          </AlertContent>
        </Alert>
      </Show>
      <Show when={props.error}>
        {(error) => (
          <Alert tone="danger" role="alert" report={false}>
            <AlertContent>
              <AlertDescription>{error()}</AlertDescription>
            </AlertContent>
          </Alert>
        )}
      </Show>
      <Show when={props.state}>
        {(state) => (
          <>
            <ItemGroup class="settings-modal-card">
              <Row labelKey="migrationDestinationPolicy.repository" value={state().policy.repository} />
              <Row labelKey="migrationDestinationPolicy.workflow" value={state().policy.workflow} />
              <Row labelKey="migrationDestinationPolicy.issuer" value={state().policy.issuer} />
              <Row labelKey="migrationDestinationPolicy.imageRepository" value={state().policy.imageRepository} />
              <Row
                labelKey="migrationDestinationPolicy.runtime"
                value={t("migrationDestinationPolicy.dockerToDocker")}
              />
              <Row
                labelKey="migrationDestinationPolicy.releaseTag"
                value={t("migrationDestinationPolicy.noApprovedTag")}
              />
            </ItemGroup>
            <SettingsSection
              title={t("migrationDestinationPolicy.exactBuild")}
              description={t("migrationDestinationPolicy.exactBuildDescription")}
            />
            <SettingsSection title={t("migrationDestinationPolicy.unavailableTitle")}>
              <ItemGroup class="settings-modal-card">
                <For each={state().unavailable}>
                  {(code) => (
                    <Item class="settings-modal-row">
                      <ItemContent>
                        <ItemDescription>{t(UNAVAILABLE_KEYS[code])}</ItemDescription>
                      </ItemContent>
                    </Item>
                  )}
                </For>
              </ItemGroup>
            </SettingsSection>
          </>
        )}
      </Show>
      <div class="agent-import-actions">
        <Button
          type="button"
          variant="outline"
          disabled={props.loading}
          loading={props.loading}
          loadingLabel={t("migrationDestinationPolicy.loading")}
          onClick={props.onReload}
        >
          {t("migrationDestinationPolicy.reload")}
        </Button>
      </div>
    </SettingsSection>
  );
}

function Row(props: { labelKey: AppTextKey; value: string }) {
  const { t } = useText();
  return (
    <Item class="settings-modal-row">
      <ItemContent>
        <ItemTitle>{t(props.labelKey)}</ItemTitle>
      </ItemContent>
      <ItemActions>{props.value}</ItemActions>
    </Item>
  );
}
