import type { DesktopPlatform } from "./ipc-app-auth";
import {
  MIGRATION_PREPARATION_BLOCKERS,
  MIGRATION_PREPARATION_DESTINATIONS,
  MIGRATION_PREPARATION_MAX_COUNT,
  type MigrationPreparationBlocker,
  type MigrationPreparationDestinationKind,
} from "./ipc-migration-preparation";
import { type DynamicRecord, isDynamicRecord, isOneOf } from "./runtime-values";

export const MIGRATION_ASSESSMENT_CATEGORIES = [
  "schema-metadata",
  "memory-search-index",
  "agents",
  "conversations",
  "agent-memories",
  "mailbox-queues",
  "attachments",
  "channels",
  "direct-chat",
  "routines",
  "routine-webhooks",
  "messaging",
  "provider-sessions-history",
  "usage",
  "mcp-config",
  "browser-profile-identities",
  "workflows",
  "events-receipts",
  "workspaces",
  "shared-files",
  "attachment-files",
  "shared-database",
  "browser-partitions",
  "provider-homes-runtimes",
  "config-files",
  "trust-state",
  "credential-stores",
  "child-server-profiles",
  "unclassified-files",
] as const;
export const MIGRATION_ASSESSMENT_FINDINGS = [
  "destination-unverified",
  "source-version-unavailable",
  "source-architecture-unsupported",
  "source-schema-unrecognized",
  "unmapped-source-tables",
  "destination-platform-undeclared",
  "destination-platform-unsupported",
  "destination-version-undeclared",
  "destination-version-mismatch",
  "destination-schema-undeclared",
  "destination-schema-mismatch",
  "platform-change-review-required",
  "architecture-change-review-required",
  "destination-executor-undeclared",
  "destination-runtime-unsupported",
  "docker-platform-mismatch",
  "executor-declaration-mismatch",
  "workspace-isolation-unsupported",
  "executor-isolation-unverified",
  "destination-root-unconfigured",
  "external-root-mapping-required",
  "destination-storage-unverified",
  "destination-storage-ephemeral",
  "inventory-coverage-incomplete",
  "inventory-observation-truncated",
  "paths-unresolved",
  "live-state-present",
  "credentials-not-inspected",
  "reauthentication-unresolved",
  "device-binding-unknown",
  "live-state-unverified",
  "source-quiescence-unverified",
] as const;
export const MIGRATION_ASSESSMENT_MAX_REVISION = 32;
export const MIGRATION_ASSESSMENT_MAX_SCHEMA_VERSION = 1_000_000;

export type MigrationAssessmentCategory = (typeof MIGRATION_ASSESSMENT_CATEGORIES)[number];
export type MigrationAssessmentFinding = (typeof MIGRATION_ASSESSMENT_FINDINGS)[number];
export interface MigrationAssessmentDestinationDeclaration {
  platform: DesktopPlatform | "unknown";
  architecture: "x64" | "arm64" | "unknown";
  appVersion: string | null;
  schemaVersion: number | null;
  executor: "process" | "container" | "vm" | "unknown";
  dataRoot: "owned" | "external" | "unspecified";
  persistence: "persistent" | "ephemeral" | "unknown";
}
export interface MigrationAssessmentSource {
  platform: DesktopPlatform;
  architecture: "x64" | "arm64" | "unsupported";
  appVersion: string | null;
  schemaVersion: number | null;
}
export interface MigrationAssessmentCategoryCoverage {
  category: MigrationAssessmentCategory;
  rowCount: number | null;
  countKind: "exact" | "at-least" | "unknown";
  coverage: "metadata-counted" | "not-inspected" | "unrecognized-schema";
}
export interface MigrationAssessmentInventory {
  categories: MigrationAssessmentCategoryCoverage[];
  schema: { expectedVersion: number; observedVersion: number | null; recognized: boolean; unmappedTables: number };
  paths: {
    managed: number;
    userData: number;
    external: number;
    relative: number;
    uri: number;
    invalid: number;
    defaults: number;
    summaryReferences: number;
    truncated: boolean;
    coverage: "metadata-extracted" | "not-inspected";
    containment: "lexical-only";
    symlinks: "not-inspected";
  };
  liveState: {
    providerSessions: number | null;
    pendingDeliveries: number | null;
    activeRoutines: number | null;
    workflowRuns: number | null;
    workflowSteps: number | null;
    pendingResultDeliveries: number | null;
    waits: number | null;
    confinedProcessAgents: number | null;
    countKind: "exact" | "at-least" | "unknown";
  };
  credentials: { coverage: "not-inspected"; reauthentication: "unresolved"; deviceBound: "unknown" };
}
export interface MigrationAssessmentReport {
  id: string;
  revision: number;
  planId: string;
  preparationRevision: number;
  createdAt: string;
  targetKind: MigrationPreparationDestinationKind;
  provenance: "offline-declaration";
  source: MigrationAssessmentSource;
  destination: MigrationAssessmentDestinationDeclaration;
  comparison: "no-known-mismatch" | "declared-mismatch" | "insufficient-info";
  findings: MigrationAssessmentFinding[];
  inventory: MigrationAssessmentInventory;
  destinationVerified: false;
  inventoryComplete: false;
  blockers: MigrationPreparationBlocker[];
  operations: { export: false; restore: false; activate: false };
}
export interface MigrationAssessmentPreparationLink {
  planId: string;
  revision: number;
  status: "prepared" | "cancelled";
}
export interface MigrationAssessmentState {
  preparation: MigrationAssessmentPreparationLink | null;
  revision: number;
  applicability: "none" | "current" | "stale";
  assessment: MigrationAssessmentReport | null;
}
export interface MigrationAssessmentAssessInput {
  planId: string;
  expectedPreparationRevision: number;
  expectedAssessmentRevision: number;
  destination: MigrationAssessmentDestinationDeclaration;
}

function reject(): never {
  throw new Error("Invalid migration assessment payload.");
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

export function decodeMigrationAssessmentDestinationDeclaration(
  value: unknown,
): MigrationAssessmentDestinationDeclaration {
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
export function decodeMigrationAssessmentSource(value: unknown): MigrationAssessmentSource {
  const input = record(value, ["platform", "architecture", "appVersion", "schemaVersion"]);
  return {
    platform: choice(["darwin", "win32", "linux"] as const, input.platform),
    architecture: choice(["x64", "arm64", "unsupported"] as const, input.architecture),
    appVersion: version(input.appVersion),
    schemaVersion: optionalCount(input.schemaVersion, MIGRATION_ASSESSMENT_MAX_SCHEMA_VERSION),
  };
}
export function parseMigrationAssessmentAssessInput(value: unknown): MigrationAssessmentAssessInput {
  const input = record(value, ["planId", "expectedPreparationRevision", "expectedAssessmentRevision", "destination"]);
  return {
    planId: uuid(input.planId),
    expectedPreparationRevision: count(input.expectedPreparationRevision),
    expectedAssessmentRevision: count(input.expectedAssessmentRevision, MIGRATION_ASSESSMENT_MAX_REVISION),
    destination: decodeMigrationAssessmentDestinationDeclaration(input.destination),
  };
}
export function decodeMigrationAssessmentInventory(value: unknown): MigrationAssessmentInventory {
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
export function decodeMigrationAssessmentReport(value: unknown): MigrationAssessmentReport {
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
  const observedSource = decodeMigrationAssessmentSource(report.source);
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
export function decodeMigrationAssessmentState(value: unknown): MigrationAssessmentState {
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
