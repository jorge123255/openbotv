import {
  MIGRATION_ASSESSMENT_MAX_REVISION,
  type MigrationAssessmentCategory,
  type MigrationAssessmentDestinationDeclaration,
  type MigrationAssessmentFinding,
  type MigrationAssessmentInventory,
  type MigrationAssessmentReport,
  type MigrationAssessmentState,
  type MigrationPreparationBlocker,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertTitle,
  Button,
  Field,
  Input,
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

export type MigrationAssessmentDeclarationDraft = Omit<
  MigrationAssessmentDestinationDeclaration,
  "appVersion" | "schemaVersion"
> & {
  appVersion: string;
  schemaVersion: string;
};

const PLATFORM_KEYS = {
  darwin: "migrationAssessment.platform.darwin",
  win32: "migrationAssessment.platform.win32",
  linux: "migrationAssessment.platform.linux",
  unknown: "migrationAssessment.unknown",
} as const satisfies Record<MigrationAssessmentDestinationDeclaration["platform"], AppTextKey>;
const ARCHITECTURE_KEYS = {
  x64: "migrationAssessment.architecture.x64",
  arm64: "migrationAssessment.architecture.arm64",
  unknown: "migrationAssessment.unknown",
} as const satisfies Record<MigrationAssessmentDestinationDeclaration["architecture"], AppTextKey>;
const EXECUTOR_KEYS = {
  process: "migrationAssessment.executor.process",
  container: "migrationAssessment.executor.container",
  vm: "migrationAssessment.executor.vm",
  unknown: "migrationAssessment.unknown",
} as const satisfies Record<MigrationAssessmentDestinationDeclaration["executor"], AppTextKey>;
const ROOT_KEYS = {
  owned: "migrationAssessment.dataRoot.owned",
  external: "migrationAssessment.dataRoot.external",
  unspecified: "migrationAssessment.dataRoot.unspecified",
} as const satisfies Record<MigrationAssessmentDestinationDeclaration["dataRoot"], AppTextKey>;
const PERSISTENCE_KEYS = {
  persistent: "migrationAssessment.persistence.persistent",
  ephemeral: "migrationAssessment.persistence.ephemeral",
  unknown: "migrationAssessment.unknown",
} as const satisfies Record<MigrationAssessmentDestinationDeclaration["persistence"], AppTextKey>;
const COMPARISON_KEYS = {
  "no-known-mismatch": "migrationAssessment.comparison.no-known-mismatch",
  "declared-mismatch": "migrationAssessment.comparison.declared-mismatch",
  "insufficient-info": "migrationAssessment.comparison.insufficient-info",
} as const satisfies Record<MigrationAssessmentReport["comparison"], AppTextKey>;
const CATEGORY_KEYS = {
  "schema-metadata": "migrationAssessment.category.schema-metadata",
  "memory-search-index": "migrationAssessment.category.memory-search-index",
  agents: "migrationAssessment.category.agents",
  conversations: "migrationAssessment.category.conversations",
  "agent-memories": "migrationAssessment.category.agent-memories",
  "mailbox-queues": "migrationAssessment.category.mailbox-queues",
  attachments: "migrationAssessment.category.attachments",
  channels: "migrationAssessment.category.channels",
  "direct-chat": "migrationAssessment.category.direct-chat",
  routines: "migrationAssessment.category.routines",
  "routine-webhooks": "migrationAssessment.category.routine-webhooks",
  messaging: "migrationAssessment.category.messaging",
  "provider-sessions-history": "migrationAssessment.category.provider-sessions-history",
  usage: "migrationAssessment.category.usage",
  "mcp-config": "migrationAssessment.category.mcp-config",
  "browser-profile-identities": "migrationAssessment.category.browser-profile-identities",
  workflows: "migrationAssessment.category.workflows",
  "events-receipts": "migrationAssessment.category.events-receipts",
  workspaces: "migrationAssessment.category.workspaces",
  "shared-files": "migrationAssessment.category.shared-files",
  "attachment-files": "migrationAssessment.category.attachment-files",
  "shared-database": "migrationAssessment.category.shared-database",
  "browser-partitions": "migrationAssessment.category.browser-partitions",
  "provider-homes-runtimes": "migrationAssessment.category.provider-homes-runtimes",
  "config-files": "migrationAssessment.category.config-files",
  "trust-state": "migrationAssessment.category.trust-state",
  "credential-stores": "migrationAssessment.category.credential-stores",
  "child-server-profiles": "migrationAssessment.category.child-server-profiles",
  "unclassified-files": "migrationAssessment.category.unclassified-files",
} as const satisfies Record<MigrationAssessmentCategory, AppTextKey>;
const FINDING_KEYS = {
  "destination-unverified": "migrationAssessment.finding.destination-unverified",
  "source-version-unavailable": "migrationAssessment.finding.source-version-unavailable",
  "source-architecture-unsupported": "migrationAssessment.finding.source-architecture-unsupported",
  "source-schema-unrecognized": "migrationAssessment.finding.source-schema-unrecognized",
  "unmapped-source-tables": "migrationAssessment.finding.unmapped-source-tables",
  "destination-platform-undeclared": "migrationAssessment.finding.destination-platform-undeclared",
  "destination-platform-unsupported": "migrationAssessment.finding.destination-platform-unsupported",
  "destination-version-undeclared": "migrationAssessment.finding.destination-version-undeclared",
  "destination-version-mismatch": "migrationAssessment.finding.destination-version-mismatch",
  "destination-schema-undeclared": "migrationAssessment.finding.destination-schema-undeclared",
  "destination-schema-mismatch": "migrationAssessment.finding.destination-schema-mismatch",
  "platform-change-review-required": "migrationAssessment.finding.platform-change-review-required",
  "architecture-change-review-required": "migrationAssessment.finding.architecture-change-review-required",
  "destination-executor-undeclared": "migrationAssessment.finding.destination-executor-undeclared",
  "destination-runtime-unsupported": "migrationAssessment.finding.destination-runtime-unsupported",
  "docker-platform-mismatch": "migrationAssessment.finding.docker-platform-mismatch",
  "executor-declaration-mismatch": "migrationAssessment.finding.executor-declaration-mismatch",
  "workspace-isolation-unsupported": "migrationAssessment.finding.workspace-isolation-unsupported",
  "executor-isolation-unverified": "migrationAssessment.finding.executor-isolation-unverified",
  "destination-root-unconfigured": "migrationAssessment.finding.destination-root-unconfigured",
  "external-root-mapping-required": "migrationAssessment.finding.external-root-mapping-required",
  "destination-storage-unverified": "migrationAssessment.finding.destination-storage-unverified",
  "destination-storage-ephemeral": "migrationAssessment.finding.destination-storage-ephemeral",
  "inventory-coverage-incomplete": "migrationAssessment.finding.inventory-coverage-incomplete",
  "inventory-observation-truncated": "migrationAssessment.finding.inventory-observation-truncated",
  "paths-unresolved": "migrationAssessment.finding.paths-unresolved",
  "live-state-present": "migrationAssessment.finding.live-state-present",
  "credentials-not-inspected": "migrationAssessment.finding.credentials-not-inspected",
  "reauthentication-unresolved": "migrationAssessment.finding.reauthentication-unresolved",
  "device-binding-unknown": "migrationAssessment.finding.device-binding-unknown",
  "live-state-unverified": "migrationAssessment.finding.live-state-unverified",
  "source-quiescence-unverified": "migrationAssessment.finding.source-quiescence-unverified",
} as const satisfies Record<MigrationAssessmentFinding, AppTextKey>;
const BLOCKER_KEYS = {
  "destination-unconfigured": "migrationPreparation.blockers.destination-unconfigured",
  "snapshot-unavailable": "migrationPreparation.blockers.snapshot-unavailable",
  "credentials-unavailable": "migrationPreparation.blockers.credentials-unavailable",
  "fencing-unavailable": "migrationPreparation.blockers.fencing-unavailable",
  "restore-unavailable": "migrationPreparation.blockers.restore-unavailable",
  "activation-unavailable": "migrationPreparation.blockers.activation-unavailable",
} as const satisfies Record<MigrationPreparationBlocker, AppTextKey>;
const PATH_KEYS = {
  managed: "migrationAssessment.paths.managed",
  userData: "migrationAssessment.paths.userData",
  external: "migrationAssessment.paths.external",
  relative: "migrationAssessment.paths.relative",
  uri: "migrationAssessment.paths.uri",
  invalid: "migrationAssessment.paths.invalid",
  defaults: "migrationAssessment.paths.defaults",
  summaryReferences: "migrationAssessment.paths.summaryReferences",
} as const satisfies Record<
  "managed" | "userData" | "external" | "relative" | "uri" | "invalid" | "defaults" | "summaryReferences",
  AppTextKey
>;
const LIVE_KEYS = {
  providerSessions: "migrationAssessment.live.providerSessions",
  pendingDeliveries: "migrationAssessment.live.pendingDeliveries",
  activeRoutines: "migrationAssessment.live.activeRoutines",
  workflowRuns: "migrationAssessment.live.workflowRuns",
  workflowSteps: "migrationAssessment.live.workflowSteps",
  pendingResultDeliveries: "migrationAssessment.live.pendingResultDeliveries",
  waits: "migrationAssessment.live.waits",
  confinedProcessAgents: "migrationAssessment.live.confinedProcessAgents",
} as const satisfies Record<Exclude<keyof MigrationAssessmentInventory["liveState"], "countKind">, AppTextKey>;
const pathFields: (keyof typeof PATH_KEYS)[] = [
  "managed",
  "userData",
  "external",
  "relative",
  "uri",
  "invalid",
  "defaults",
  "summaryReferences",
];
const liveFields: (keyof typeof LIVE_KEYS)[] = [
  "providerSessions",
  "pendingDeliveries",
  "activeRoutines",
  "workflowRuns",
  "workflowSteps",
  "pendingResultDeliveries",
  "waits",
  "confinedProcessAgents",
];

export interface MigrationAssessmentViewProps {
  state: MigrationAssessmentState | null;
  declaration: MigrationAssessmentDeclarationDraft;
  ready: boolean;
  preparationChanged: boolean;
  canAssess: boolean;
  busy: "loading" | "assessing" | null;
  error: string | null;
  validationError: string | null;
  onDeclarationChange: <Key extends keyof MigrationAssessmentDeclarationDraft>(
    key: Key,
    value: MigrationAssessmentDeclarationDraft[Key],
  ) => void;
  onAssess: () => void;
  onReload: () => void;
}

/** Offline declarations and metadata. No host connection, credential operation or migration action. */
export function MigrationAssessmentView(props: MigrationAssessmentViewProps) {
  const { t } = useText();
  const disabled = () => !props.canAssess || !props.ready || Boolean(props.busy);
  const limitReached = () => (props.state?.revision ?? 0) >= MIGRATION_ASSESSMENT_MAX_REVISION;
  const currentReport = () =>
    !props.preparationChanged && props.state?.applicability === "current" ? props.state.assessment : null;
  return (
    <SettingsSection
      title={t("migrationAssessment.title")}
      description={t("migrationAssessment.description")}
      aria-busy={props.busy ? "true" : undefined}
    >
      <Notice message={t("migrationAssessment.unverified")} />
      <Show when={!props.canAssess}>
        <Notice message={t("migrationAssessment.windowsUnavailable")} />
      </Show>
      <Show when={limitReached()}>
        <Notice message={t("migrationAssessment.limitReached")} />
      </Show>
      <Show when={props.preparationChanged || props.state?.applicability === "stale"}>
        <Notice message={t("migrationAssessment.stale")} />
      </Show>
      <Show when={props.error}>{(error) => <Notice message={error()} danger />}</Show>
      <SettingsSection
        title={t("migrationAssessment.declaration")}
        description={t("migrationAssessment.declarationDescription")}
      >
        <ItemGroup class="settings-modal-card">
          <ChoiceRow
            labelKey="migrationAssessment.platform"
            options={["unknown", "darwin", "win32", "linux"]}
            value={props.declaration.platform}
            labels={PLATFORM_KEYS}
            disabled={disabled()}
            onChange={(value) => props.onDeclarationChange("platform", value)}
          />
          <ChoiceRow
            labelKey="migrationAssessment.architecture"
            options={["unknown", "x64", "arm64"]}
            value={props.declaration.architecture}
            labels={ARCHITECTURE_KEYS}
            disabled={disabled()}
            onChange={(value) => props.onDeclarationChange("architecture", value)}
          />
          <Item class="settings-modal-row">
            <ItemContent>
              <Field label={t("migrationAssessment.appVersion")} description={t("migrationAssessment.optionalVersion")}>
                <Input
                  type="text"
                  size="sm"
                  value={props.declaration.appVersion}
                  maxlength={64}
                  disabled={disabled()}
                  onValueChange={(value) => props.onDeclarationChange("appVersion", value)}
                />
              </Field>
            </ItemContent>
          </Item>
          <Item class="settings-modal-row">
            <ItemContent>
              <Field
                label={t("migrationAssessment.schemaVersion")}
                description={t("migrationAssessment.optionalVersion")}
              >
                <Input
                  type="text"
                  inputmode="numeric"
                  size="sm"
                  value={props.declaration.schemaVersion}
                  maxlength={7}
                  disabled={disabled()}
                  onValueChange={(value) => props.onDeclarationChange("schemaVersion", value)}
                />
              </Field>
            </ItemContent>
          </Item>
          <ChoiceRow
            labelKey="migrationAssessment.executor"
            options={["unknown", "process", "container", "vm"]}
            value={props.declaration.executor}
            labels={EXECUTOR_KEYS}
            disabled={disabled()}
            onChange={(value) => props.onDeclarationChange("executor", value)}
          />
          <ChoiceRow
            labelKey="migrationAssessment.dataRoot"
            options={["unspecified", "owned", "external"]}
            value={props.declaration.dataRoot}
            labels={ROOT_KEYS}
            disabled={disabled()}
            onChange={(value) => props.onDeclarationChange("dataRoot", value)}
          />
          <ChoiceRow
            labelKey="migrationAssessment.persistence"
            options={["unknown", "persistent", "ephemeral"]}
            value={props.declaration.persistence}
            labels={PERSISTENCE_KEYS}
            disabled={disabled()}
            onChange={(value) => props.onDeclarationChange("persistence", value)}
          />
        </ItemGroup>
      </SettingsSection>
      <Show when={props.validationError}>{(error) => <Notice message={error()} danger />}</Show>
      <div class="agent-import-actions">
        <Button
          type="button"
          disabled={disabled() || limitReached()}
          loading={props.busy === "assessing"}
          loadingLabel={t("migrationAssessment.assessing")}
          onClick={props.onAssess}
        >
          {t("migrationAssessment.assess")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={Boolean(props.busy)}
          loading={props.busy === "loading"}
          loadingLabel={t("migrationAssessment.loading")}
          onClick={props.onReload}
        >
          {t("migrationAssessment.reload")}
        </Button>
      </div>
      <Show when={currentReport()}>{(report) => <AssessmentReport report={report()} />}</Show>
    </SettingsSection>
  );
}

function ChoiceRow<Option extends string>(props: {
  labelKey: AppTextKey;
  options: Option[];
  value: Option;
  labels: Record<Option, AppTextKey>;
  disabled: boolean;
  onChange: (value: Option) => void;
}) {
  const { t } = useText();
  const choiceText = (key: AppTextKey) => t(key);
  const label = (value: Option | undefined) => (value === undefined ? "" : choiceText(props.labels[value]));
  return (
    <Item class="settings-modal-row">
      <ItemContent>
        <ItemTitle>{t(props.labelKey)}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Select<Option>
          class="settings-modal-select"
          options={props.options}
          value={props.value}
          disabled={props.disabled}
          onChange={(value) => value && props.onChange(value)}
          itemComponent={(item) => <SelectItem item={item.item}>{label(item.item.rawValue)}</SelectItem>}
        >
          <SelectTrigger size="sm" aria-label={t(props.labelKey)}>
            <SelectValue<Option>>{(state) => label(state.selectedOption())}</SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </ItemActions>
    </Item>
  );
}

function Notice(props: { message: string; danger?: boolean }) {
  return (
    <Alert tone={props.danger ? "danger" : "neutral"} role={props.danger ? "alert" : "status"} report={false}>
      <AlertContent>
        <AlertDescription>{props.message}</AlertDescription>
      </AlertContent>
    </Alert>
  );
}

function ReadRow(props: { labelKey: AppTextKey; value: string }) {
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

function AssessmentReport(props: { report: MigrationAssessmentReport }) {
  const { t, format } = useText();
  const count = (value: number | null, kind: "exact" | "at-least" | "unknown") =>
    value === null || kind === "unknown"
      ? t("migrationAssessment.uninspected")
      : kind === "at-least"
        ? t("migrationAssessment.atLeastValue", { value: format.number(value) })
        : format.number(value);
  return (
    <>
      <Alert tone="neutral" role="status" report={false}>
        <AlertContent>
          <AlertTitle>{t(COMPARISON_KEYS[props.report.comparison])}</AlertTitle>
          <AlertDescription>{t("migrationAssessment.current")}</AlertDescription>
          <AlertDescription>{t("migrationAssessment.unverified")}</AlertDescription>
        </AlertContent>
      </Alert>
      <ItemGroup class="settings-modal-card">
        <ReadRow labelKey="migrationAssessment.verified" value={t("migrationAssessment.no")} />
        <ReadRow labelKey="migrationAssessment.inventoryComplete" value={t("migrationAssessment.no")} />
      </ItemGroup>
      <SettingsSection title={t("migrationAssessment.source")}>
        <ItemGroup class="settings-modal-card">
          <ReadRow
            labelKey="migrationAssessment.source.platform"
            value={t(PLATFORM_KEYS[props.report.source.platform])}
          />
          <ReadRow
            labelKey="migrationAssessment.source.architecture"
            value={
              props.report.source.architecture === "unsupported"
                ? t("migrationAssessment.unsupported")
                : t(ARCHITECTURE_KEYS[props.report.source.architecture])
            }
          />
          <ReadRow
            labelKey="migrationAssessment.source.appVersion"
            value={props.report.source.appVersion ?? t("migrationAssessment.unknown")}
          />
          <ReadRow
            labelKey="migrationAssessment.source.schemaVersion"
            value={
              props.report.source.schemaVersion === null
                ? t("migrationAssessment.unknown")
                : format.number(props.report.source.schemaVersion, { useGrouping: false })
            }
          />
        </ItemGroup>
      </SettingsSection>
      <SettingsSection title={t("migrationAssessment.destination")}>
        <ItemGroup class="settings-modal-card">
          <ReadRow
            labelKey="migrationAssessment.platform"
            value={t(PLATFORM_KEYS[props.report.destination.platform])}
          />
          <ReadRow
            labelKey="migrationAssessment.architecture"
            value={t(ARCHITECTURE_KEYS[props.report.destination.architecture])}
          />
          <ReadRow
            labelKey="migrationAssessment.appVersion"
            value={props.report.destination.appVersion ?? t("migrationAssessment.unknown")}
          />
          <ReadRow
            labelKey="migrationAssessment.schemaVersion"
            value={
              props.report.destination.schemaVersion === null
                ? t("migrationAssessment.unknown")
                : format.number(props.report.destination.schemaVersion, { useGrouping: false })
            }
          />
          <ReadRow
            labelKey="migrationAssessment.executor"
            value={t(EXECUTOR_KEYS[props.report.destination.executor])}
          />
          <ReadRow labelKey="migrationAssessment.dataRoot" value={t(ROOT_KEYS[props.report.destination.dataRoot])} />
          <ReadRow
            labelKey="migrationAssessment.persistence"
            value={t(PERSISTENCE_KEYS[props.report.destination.persistence])}
          />
        </ItemGroup>
      </SettingsSection>
      <SettingsSection
        title={t("migrationAssessment.inventory")}
        description={t("migrationAssessment.inventoryDescription")}
      >
        <ItemGroup class="settings-modal-card">
          <For each={props.report.inventory.categories}>
            {(row) => (
              <ReadRow
                labelKey={CATEGORY_KEYS[row.category]}
                value={
                  row.coverage === "unrecognized-schema"
                    ? t("migrationAssessment.unrecognizedSchema")
                    : row.rowCount === null || row.countKind === "unknown"
                      ? t("migrationAssessment.uninspected")
                      : row.countKind === "at-least"
                        ? t("migrationAssessment.count.at-least", { count: row.rowCount })
                        : t("migrationAssessment.count.exact", { count: row.rowCount })
                }
              />
            )}
          </For>
          <ReadRow
            labelKey="migrationAssessment.schemaRecognized"
            value={t(props.report.inventory.schema.recognized ? "migrationAssessment.yes" : "migrationAssessment.no")}
          />
          <ReadRow
            labelKey="migrationAssessment.unmappedTables"
            value={format.number(props.report.inventory.schema.unmappedTables)}
          />
        </ItemGroup>
      </SettingsSection>
      <SettingsSection
        title={t("migrationAssessment.lexicalPaths")}
        description={t("migrationAssessment.lexicalPathsDescription")}
      >
        <Show
          when={props.report.inventory.paths.coverage === "metadata-extracted"}
          fallback={<Notice message={t("migrationAssessment.uninspected")} />}
        >
          <ItemGroup class="settings-modal-card">
            <For each={pathFields}>
              {(field) => (
                <ReadRow labelKey={PATH_KEYS[field]} value={format.number(props.report.inventory.paths[field])} />
              )}
            </For>
          </ItemGroup>
          <Show when={props.report.inventory.paths.truncated}>
            <Notice message={t("migrationAssessment.paths.truncated")} />
          </Show>
        </Show>
      </SettingsSection>
      <SettingsSection
        title={t("migrationAssessment.liveIntent")}
        description={t("migrationAssessment.liveIntentDescription")}
      >
        <ItemGroup class="settings-modal-card">
          <For each={liveFields}>
            {(field) => (
              <ReadRow
                labelKey={LIVE_KEYS[field]}
                value={count(props.report.inventory.liveState[field], props.report.inventory.liveState.countKind)}
              />
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
      <SettingsSection
        title={t("migrationAssessment.credentials")}
        description={t("migrationAssessment.credentialsDescription")}
      />
      <SettingsSection title={t("migrationAssessment.findings")}>
        <ItemGroup class="settings-modal-card">
          <For each={props.report.findings}>
            {(finding) => (
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemDescription>{t(FINDING_KEYS[finding])}</ItemDescription>
                </ItemContent>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
      <SettingsSection title={t("migrationAssessment.baseBlockers")}>
        <ItemGroup class="settings-modal-card">
          <For each={props.report.blockers}>
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
  );
}
