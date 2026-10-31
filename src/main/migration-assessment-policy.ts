import {
  MIGRATION_ASSESSMENT_FINDINGS,
  type MigrationAssessmentDestinationDeclaration,
  type MigrationAssessmentFinding,
  type MigrationAssessmentInventory,
  type MigrationAssessmentReport,
  type MigrationAssessmentSource,
} from "@openbot/contracts/ipc-migration-assessment";
import type { MigrationPreparationDestinationKind } from "@openbot/contracts/ipc-migration-preparation";

/** Compare declared facts only. No outcome certifies a destination or clears a migration gate. */
export function assessMigrationDeclaration(
  source: MigrationAssessmentSource,
  destination: MigrationAssessmentDestinationDeclaration,
  targetKind: MigrationPreparationDestinationKind,
  inventory: MigrationAssessmentInventory,
): Pick<MigrationAssessmentReport, "comparison" | "findings"> {
  const findings = new Set<MigrationAssessmentFinding>([
    "destination-unverified",
    "executor-isolation-unverified",
    "inventory-coverage-incomplete",
    "paths-unresolved",
    "credentials-not-inspected",
    "reauthentication-unresolved",
    "device-binding-unknown",
    "source-quiescence-unverified",
    "destination-storage-unverified",
  ]);
  let mismatch = false;
  let insufficient = false;
  const unknown = (finding: MigrationAssessmentFinding) => {
    findings.add(finding);
    insufficient = true;
  };
  const incompatible = (finding: MigrationAssessmentFinding) => {
    findings.add(finding);
    mismatch = true;
  };
  if (source.appVersion === null) unknown("source-version-unavailable");
  if (source.architecture === "unsupported") unknown("source-architecture-unsupported");
  if (!inventory.schema.recognized || source.schemaVersion === null) unknown("source-schema-unrecognized");
  if (inventory.schema.unmappedTables > 0) findings.add("unmapped-source-tables");
  if (destination.platform === "unknown") unknown("destination-platform-undeclared");
  if (destination.architecture === "unknown") unknown("destination-runtime-unsupported");
  if (destination.platform === "win32" && destination.architecture === "arm64")
    incompatible("destination-platform-unsupported");
  if (destination.appVersion === null) unknown("destination-version-undeclared");
  else if (source.appVersion !== null && destination.appVersion !== source.appVersion)
    incompatible("destination-version-mismatch");
  if (destination.schemaVersion === null) unknown("destination-schema-undeclared");
  else if (source.schemaVersion !== null && destination.schemaVersion !== source.schemaVersion)
    incompatible("destination-schema-mismatch");
  if (destination.platform !== "unknown" && source.platform !== destination.platform)
    findings.add("platform-change-review-required");
  if (
    destination.architecture !== "unknown" &&
    source.architecture !== "unsupported" &&
    source.architecture !== destination.architecture
  )
    findings.add("architecture-change-review-required");
  if (destination.executor === "unknown") unknown("destination-executor-undeclared");
  if (targetKind === "docker-host") {
    if (destination.platform !== "linux" && destination.platform !== "unknown")
      incompatible("docker-platform-mismatch");
    if (destination.executor !== "container" && destination.executor !== "unknown")
      incompatible("executor-declaration-mismatch");
  }
  if (
    destination.platform !== "darwin" &&
    destination.platform !== "unknown" &&
    (inventory.liveState.confinedProcessAgents ?? 0) > 0
  )
    incompatible("workspace-isolation-unsupported");
  if (destination.dataRoot === "unspecified") unknown("destination-root-unconfigured");
  if (destination.dataRoot === "external" || inventory.paths.external > 0) unknown("external-root-mapping-required");
  if (
    inventory.paths.coverage === "not-inspected" ||
    inventory.paths.relative > 0 ||
    inventory.paths.uri > 0 ||
    inventory.paths.invalid > 0
  )
    insufficient = true;
  if (destination.persistence === "unknown") unknown("destination-storage-unverified");
  if (destination.persistence === "ephemeral") incompatible("destination-storage-ephemeral");
  if (
    inventory.paths.truncated ||
    inventory.categories.some((category) => category.countKind === "at-least") ||
    inventory.liveState.countKind === "at-least"
  )
    unknown("inventory-observation-truncated");
  if (inventory.liveState.countKind === "unknown") unknown("live-state-unverified");
  else if (
    [
      inventory.liveState.providerSessions,
      inventory.liveState.pendingDeliveries,
      inventory.liveState.activeRoutines,
      inventory.liveState.workflowRuns,
      inventory.liveState.workflowSteps,
      inventory.liveState.pendingResultDeliveries,
      inventory.liveState.waits,
    ].some((count) => count !== null && count > 0)
  )
    findings.add("live-state-present");
  return {
    comparison: mismatch ? "declared-mismatch" : insufficient ? "insufficient-info" : "no-known-mismatch",
    findings: MIGRATION_ASSESSMENT_FINDINGS.filter((code) => findings.has(code)),
  };
}
