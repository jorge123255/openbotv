import {
  MIGRATION_ASSESSMENT_CATEGORIES,
  MIGRATION_ASSESSMENT_FINDINGS,
  MIGRATION_ASSESSMENT_MAX_REVISION,
  MIGRATION_ASSESSMENT_MAX_SCHEMA_VERSION,
  MIGRATION_PREPARATION_BLOCKERS,
  MIGRATION_PREPARATION_DESTINATIONS,
  MIGRATION_PREPARATION_MAX_COUNT,
  type MigrationAssessmentCategoryCoverage,
  type MigrationAssessmentDestinationDeclaration,
  type MigrationAssessmentInventory,
  type MigrationAssessmentPreparationLink,
  type MigrationAssessmentReport,
  type MigrationAssessmentSource,
  type MigrationAssessmentState,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";

// Independent local-only main-to-renderer boundary. No contract response parser is imported.
function reject(): never {
  throw new Error("Invalid migration assessment state from main.");
}
function record(value: unknown, keys: readonly string[]): DynamicRecord {
  if (
    !isDynamicRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    reject();
  return value;
}
function count(value: unknown, maximum = MIGRATION_PREPARATION_MAX_COUNT, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) reject();
  return value;
}
function optionalCount(value: unknown, maximum = MIGRATION_PREPARATION_MAX_COUNT): number | null {
  return value === null ? null : count(value, maximum);
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    reject();
  return value;
}
function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    reject();
  return value;
}
function version(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    ) ||
    value.trim() !== value
  )
    reject();
  return value;
}
function choice<T extends string>(values: readonly T[], value: unknown): T {
  if (!isOneOf(values, value)) reject();
  return value;
}
function codes<T extends string>(value: unknown, allowed: readonly T[], complete = false): T[] {
  if (!Array.isArray(value) || value.length > allowed.length || (complete && value.length !== allowed.length)) reject();
  const result: T[] = [];
  let previous = -1;
  for (const item of value) {
    const code = choice(allowed, item);
    const index = allowed.indexOf(code);
    if (index <= previous) reject();
    previous = index;
    result.push(code);
  }
  return result;
}

function decodeMigrationAssessmentDestinationDeclaration(value: unknown): MigrationAssessmentDestinationDeclaration {
  const input = record(value, [
    "platform",
    "architecture",
    "appVersion",
    "schemaVersion",
    "executor",
    "dataRoot",
    "persistence",
  ]);
  return {
    platform: choice(["darwin", "win32", "linux", "unknown"] as const, input.platform),
    architecture: choice(["x64", "arm64", "unknown"] as const, input.architecture),
    appVersion: version(input.appVersion),
    schemaVersion: optionalCount(input.schemaVersion, MIGRATION_ASSESSMENT_MAX_SCHEMA_VERSION),
    executor: choice(["process", "container", "vm", "unknown"] as const, input.executor),
    dataRoot: choice(["owned", "external", "unspecified"] as const, input.dataRoot),
    persistence: choice(["persistent", "ephemeral", "unknown"] as const, input.persistence),
  };
}
function source(value: unknown): MigrationAssessmentSource {
  const input = record(value, ["platform", "architecture", "appVersion", "schemaVersion"]);
  return {
    platform: choice(["darwin", "win32", "linux"] as const, input.platform),
    architecture: choice(["x64", "arm64", "unsupported"] as const, input.architecture),
    appVersion: version(input.appVersion),
    schemaVersion: optionalCount(input.schemaVersion, MIGRATION_ASSESSMENT_MAX_SCHEMA_VERSION),
  };
}
function decodeMigrationAssessmentInventory(value: unknown): MigrationAssessmentInventory {
  const input = record(value, ["categories", "schema", "paths", "liveState", "credentials"]);
  if (!Array.isArray(input.categories) || input.categories.length !== MIGRATION_ASSESSMENT_CATEGORIES.length) reject();
  const categories = input.categories.map((value, index): MigrationAssessmentCategoryCoverage => {
    const row = record(value, ["category", "rowCount", "countKind", "coverage"]);
    const category = choice(MIGRATION_ASSESSMENT_CATEGORIES, row.category);
    if (category !== MIGRATION_ASSESSMENT_CATEGORIES[index]) reject();
    const countKind = choice(["exact", "at-least", "unknown"] as const, row.countKind);
    const coverage = choice(["metadata-counted", "not-inspected", "unrecognized-schema"] as const, row.coverage);
    const rowCount = optionalCount(row.rowCount);
    if (
      (coverage === "metadata-counted" && (rowCount === null || countKind === "unknown")) ||
      (coverage !== "metadata-counted" && (rowCount !== null || countKind !== "unknown"))
    )
      reject();
    return { category, rowCount, countKind, coverage };
  });
  const schema = record(input.schema, ["expectedVersion", "observedVersion", "recognized", "unmappedTables"]);
  if (typeof schema.recognized !== "boolean") reject();
  const paths = record(input.paths, [
    "managed",
    "userData",
    "external",
    "relative",
    "uri",
    "invalid",
    "defaults",
    "summaryReferences",
    "truncated",
    "coverage",
    "containment",
    "symlinks",
  ]);
  if (
    typeof paths.truncated !== "boolean" ||
    paths.containment !== "lexical-only" ||
    paths.symlinks !== "not-inspected"
  )
    reject();
  const pathCoverage = choice(["metadata-extracted", "not-inspected"] as const, paths.coverage);
  const pathCounts = {
    managed: count(paths.managed, 4096),
    userData: count(paths.userData, 4096),
    external: count(paths.external, 4096),
    relative: count(paths.relative, 4096),
    uri: count(paths.uri, 4096),
    invalid: count(paths.invalid, 4096),
    defaults: count(paths.defaults, 4096),
    summaryReferences: count(paths.summaryReferences, 4096),
  };
  if (pathCoverage === "not-inspected" && (Object.values(pathCounts).some((value) => value !== 0) || paths.truncated))
    reject();
  const live = record(input.liveState, [
    "providerSessions",
    "pendingDeliveries",
    "activeRoutines",
    "workflowRuns",
    "workflowSteps",
    "pendingResultDeliveries",
    "waits",
    "confinedProcessAgents",
    "countKind",
  ]);
  const liveKind = choice(["exact", "at-least", "unknown"] as const, live.countKind);
  const liveCounts = {
    providerSessions: optionalCount(live.providerSessions),
    pendingDeliveries: optionalCount(live.pendingDeliveries),
    activeRoutines: optionalCount(live.activeRoutines),
    workflowRuns: optionalCount(live.workflowRuns),
    workflowSteps: optionalCount(live.workflowSteps),
    pendingResultDeliveries: optionalCount(live.pendingResultDeliveries),
    waits: optionalCount(live.waits),
    confinedProcessAgents: optionalCount(live.confinedProcessAgents),
  };
  if (Object.values(liveCounts).some((value) => (liveKind === "unknown" ? value !== null : value === null))) reject();
  const credentials = record(input.credentials, ["coverage", "reauthentication", "deviceBound"]);
  if (
    credentials.coverage !== "not-inspected" ||
    credentials.reauthentication !== "unresolved" ||
    credentials.deviceBound !== "unknown"
  )
    reject();
  return {
    categories,
    schema: {
      expectedVersion: count(schema.expectedVersion, MIGRATION_ASSESSMENT_MAX_SCHEMA_VERSION),
      observedVersion: optionalCount(schema.observedVersion, MIGRATION_ASSESSMENT_MAX_SCHEMA_VERSION),
      recognized: schema.recognized,
      unmappedTables: count(schema.unmappedTables),
    },
    paths: {
      ...pathCounts,
      truncated: paths.truncated,
      coverage: pathCoverage,
      containment: "lexical-only",
      symlinks: "not-inspected",
    },
    liveState: { ...liveCounts, countKind: liveKind },
    credentials: { coverage: "not-inspected", reauthentication: "unresolved", deviceBound: "unknown" },
  };
}
function decodeMigrationAssessmentReport(value: unknown): MigrationAssessmentReport {
  const report = record(value, [
    "id",
    "revision",
    "planId",
    "preparationRevision",
    "createdAt",
    "targetKind",
    "provenance",
    "source",
    "destination",
    "comparison",
    "findings",
    "inventory",
    "destinationVerified",
    "inventoryComplete",
    "blockers",
    "operations",
  ]);
  if (
    report.provenance !== "offline-declaration" ||
    report.destinationVerified !== false ||
    report.inventoryComplete !== false
  )
    reject();
  const operations = record(report.operations, ["export", "restore", "activate"]);
  if (operations.export !== false || operations.restore !== false || operations.activate !== false) reject();
  const observedSource = source(report.source);
  const inventory = decodeMigrationAssessmentInventory(report.inventory);
  if (observedSource.schemaVersion !== inventory.schema.observedVersion) reject();
  return {
    id: uuid(report.id),
    revision: count(report.revision, MIGRATION_ASSESSMENT_MAX_REVISION, 1),
    planId: uuid(report.planId),
    preparationRevision: count(report.preparationRevision, MIGRATION_PREPARATION_MAX_COUNT, 1),
    createdAt: date(report.createdAt),
    targetKind: choice(MIGRATION_PREPARATION_DESTINATIONS, report.targetKind),
    provenance: "offline-declaration",
    source: observedSource,
    destination: decodeMigrationAssessmentDestinationDeclaration(report.destination),
    comparison: choice(["no-known-mismatch", "declared-mismatch", "insufficient-info"] as const, report.comparison),
    findings: codes(report.findings, MIGRATION_ASSESSMENT_FINDINGS),
    inventory,
    destinationVerified: false,
    inventoryComplete: false,
    blockers: codes(report.blockers, MIGRATION_PREPARATION_BLOCKERS, true),
    operations: { export: false, restore: false, activate: false },
  };
}
export function decodeMigrationAssessmentStateForRenderer(value: unknown): MigrationAssessmentState {
  const state = record(value, ["preparation", "revision", "applicability", "assessment"]);
  let preparation: MigrationAssessmentPreparationLink | null = null;
  if (state.preparation !== null) {
    const link = record(state.preparation, ["planId", "revision", "status"]);
    preparation = {
      planId: uuid(link.planId),
      revision: count(link.revision, MIGRATION_PREPARATION_MAX_COUNT, 1),
      status: choice(["prepared", "cancelled"] as const, link.status),
    };
  }
  const revision = count(state.revision, MIGRATION_ASSESSMENT_MAX_REVISION);
  const applicability = choice(["none", "current", "stale"] as const, state.applicability);
  if (state.assessment === null) {
    if (revision !== 0 || applicability !== "none") reject();
    return { preparation, revision, applicability, assessment: null };
  }
  const assessment = decodeMigrationAssessmentReport(state.assessment);
  const current =
    preparation?.status === "prepared" &&
    preparation.planId === assessment.planId &&
    preparation.revision === assessment.preparationRevision;
  if (revision !== assessment.revision || applicability === "none" || (applicability === "current") !== current)
    reject();
  return { preparation, revision, applicability, assessment };
}
