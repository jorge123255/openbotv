import {
  type AppInfo,
  decodeMigrationAssessmentDestinationDeclaration,
  decodeMigrationAssessmentReport,
  decodeMigrationAssessmentState,
  MIGRATION_ASSESSMENT_CATEGORIES,
  MIGRATION_ASSESSMENT_FINDINGS,
  MIGRATION_ASSESSMENT_MAX_REVISION,
  MIGRATION_PREPARATION_BLOCKERS,
  type MigrationAssessmentCategoryCoverage,
  type MigrationAssessmentFinding,
  type MigrationAssessmentInventory,
  type MigrationAssessmentReport,
  type MigrationAssessmentState,
  type MigrationPreparationState,
  type OpenBotDesktopApi,
  parseMigrationAssessmentAssessInput,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";

function previewInventory(preparation: MigrationPreparationState): MigrationAssessmentInventory {
  const counts = preparation.plan?.inventory;
  const observed = new Map([
    ["agents", counts?.agents ?? 0],
    ["conversations", (counts?.conversations ?? 0) + (counts?.messages ?? 0)],
    ["attachments", counts?.attachments ?? 0],
    ["routines", counts?.routines ?? 0],
  ]);
  const categories = MIGRATION_ASSESSMENT_CATEGORIES.map<MigrationAssessmentCategoryCoverage>((category) => {
    const rowCount = observed.get(category);
    return rowCount === undefined
      ? { category, rowCount: null, countKind: "unknown", coverage: "not-inspected" }
      : { category, rowCount, countKind: "at-least", coverage: "metadata-counted" };
  });
  return {
    categories,
    schema: { expectedVersion: 0, observedVersion: null, recognized: false, unmappedTables: 0 },
    paths: {
      managed: 0,
      userData: 0,
      external: 0,
      relative: 0,
      uri: 0,
      invalid: 0,
      defaults: 0,
      summaryReferences: 0,
      truncated: false,
      coverage: "not-inspected",
      containment: "lexical-only",
      symlinks: "not-inspected",
    },
    liveState: {
      providerSessions: null,
      pendingDeliveries: null,
      activeRoutines: null,
      workflowRuns: null,
      workflowSteps: null,
      pendingResultDeliveries: null,
      waits: null,
      confinedProcessAgents: null,
      countKind: "unknown",
    },
    credentials: { coverage: "not-inspected", reauthentication: "unresolved", deviceBound: "unknown" },
  };
}

/** Informational preview history. Both getters stay lazy so story-injected preparation is current. */
export function createMockMigrationAssessment(
  readPreparation: () => Promise<MigrationPreparationState>,
  readAppInfo: () => Promise<AppInfo>,
): OpenBotDesktopApi["migrationAssessment"] {
  const reports = new Map<string, MigrationAssessmentReport[]>();
  const fail = (): never => {
    throw new Error(sourceText("error.migration.assessmentFailed"));
  };
  const snapshot = (preparation: MigrationPreparationState): MigrationAssessmentState => {
    const plan = preparation.plan;
    const assessment = plan ? (reports.get(plan.id)?.at(-1) ?? null) : null;
    return decodeMigrationAssessmentState({
      preparation: plan ? { planId: plan.id, revision: preparation.revision, status: plan.status } : null,
      revision: assessment?.revision ?? 0,
      applicability:
        assessment === null
          ? "none"
          : plan?.status === "prepared" && preparation.revision === assessment.preparationRevision
            ? "current"
            : "stale",
      assessment,
    });
  };
  return {
    getState: async () => snapshot(await readPreparation()),
    assess: async (value) => {
      const input = parseMigrationAssessmentAssessInput(value);
      const info = await readAppInfo();
      const preparation = await readPreparation();
      const plan = preparation.plan;
      if (
        plan?.status !== "prepared" ||
        plan.id !== input.planId ||
        preparation.revision !== input.expectedPreparationRevision
      )
        return fail();
      const history = reports.get(plan.id) ?? [];
      if (history.length !== input.expectedAssessmentRevision || history.length >= MIGRATION_ASSESSMENT_MAX_REVISION)
        return fail();
      let appVersion: string | null = null;
      try {
        appVersion = decodeMigrationAssessmentDestinationDeclaration({
          ...input.destination,
          appVersion: info.version,
        }).appVersion;
      } catch {
        /* Preview metadata may have an unavailable build version. */
      }
      const findings = new Set<MigrationAssessmentFinding>([
        "destination-unverified",
        "source-architecture-unsupported",
        "source-schema-unrecognized",
        "executor-isolation-unverified",
        "inventory-coverage-incomplete",
        "inventory-observation-truncated",
        "paths-unresolved",
        "destination-storage-unverified",
        "credentials-not-inspected",
        "reauthentication-unresolved",
        "device-binding-unknown",
        "live-state-unverified",
        "source-quiescence-unverified",
      ]);
      let mismatch = false;
      if (appVersion === null) findings.add("source-version-unavailable");
      if (input.destination.platform === "unknown") findings.add("destination-platform-undeclared");
      else if (input.destination.platform !== info.platform) {
        findings.add("platform-change-review-required");
      }
      if (input.destination.architecture === "unknown") findings.add("destination-runtime-unsupported");
      if (input.destination.platform === "win32" && input.destination.architecture === "arm64") {
        findings.add("destination-platform-unsupported");
        mismatch = true;
      }
      if (input.destination.appVersion === null) findings.add("destination-version-undeclared");
      else if (appVersion !== null && input.destination.appVersion !== appVersion) {
        findings.add("destination-version-mismatch");
        mismatch = true;
      }
      if (input.destination.schemaVersion === null) findings.add("destination-schema-undeclared");
      if (input.destination.executor === "unknown") findings.add("destination-executor-undeclared");
      if (input.destination.dataRoot === "unspecified") findings.add("destination-root-unconfigured");
      if (input.destination.dataRoot === "external") findings.add("external-root-mapping-required");
      if (input.destination.persistence === "unknown") findings.add("destination-storage-unverified");
      if (input.destination.persistence === "ephemeral") {
        findings.add("destination-storage-ephemeral");
        mismatch = true;
      }
      if (
        plan.destinationKind === "docker-host" &&
        input.destination.platform !== "linux" &&
        input.destination.platform !== "unknown"
      ) {
        findings.add("docker-platform-mismatch");
        mismatch = true;
      }
      if (
        plan.destinationKind === "docker-host" &&
        (input.destination.executor === "process" || input.destination.executor === "vm")
      ) {
        findings.add("executor-declaration-mismatch");
        mismatch = true;
      }
      const report = decodeMigrationAssessmentReport({
        id: crypto.randomUUID(),
        revision: history.length + 1,
        planId: plan.id,
        preparationRevision: preparation.revision,
        createdAt: new Date().toISOString(),
        targetKind: plan.destinationKind,
        provenance: "offline-declaration",
        source: { platform: info.platform, architecture: "unsupported", appVersion, schemaVersion: null },
        destination: input.destination,
        comparison: mismatch ? "declared-mismatch" : "insufficient-info",
        findings: MIGRATION_ASSESSMENT_FINDINGS.filter((code) => findings.has(code)),
        inventory: previewInventory(preparation),
        destinationVerified: false,
        inventoryComplete: false,
        blockers: [...MIGRATION_PREPARATION_BLOCKERS],
        operations: { export: false, restore: false, activate: false },
      });
      reports.set(plan.id, [...history, report]);
      return snapshot(preparation);
    },
  };
}
