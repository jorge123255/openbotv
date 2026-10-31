import {
  MIGRATION_ASSESSMENT_MAX_REVISION,
  type MigrationAssessmentAssessInput,
  type MigrationAssessmentState,
  type MigrationPreparationState,
  parseMigrationAssessmentAssessInput,
} from "@openbot/contracts/ipc";
import type { MigrationAssessmentDeclarationDraft } from "@openbot/ui/features/migration/MigrationAssessmentView";
import { currentText } from "@openbot/ui/text";
import { createStore } from "solid-js";
import type { MigrationAssessmentCalls } from "./migration-assessment-port";

interface AssessmentViewState {
  value: MigrationAssessmentState | null;
  declaration: MigrationAssessmentDeclarationDraft;
  busy: "loading" | "assessing" | null;
  ready: boolean;
  error: string | null;
  validationError: string | null;
}

/** Main owns revisions and report applicability. An uncertain save is read back, never replayed. */
export function createMigrationAssessmentStore(
  calls: MigrationAssessmentCalls,
  preparationState: () => MigrationPreparationState,
  canAssess: () => boolean,
) {
  const [state, setState] = createStore<AssessmentViewState>({
    value: null,
    declaration: {
      platform: "unknown",
      architecture: "unknown",
      appVersion: "",
      schemaVersion: "",
      executor: "unknown",
      dataRoot: "unspecified",
      persistence: "unknown",
    },
    busy: null,
    ready: false,
    error: null,
    validationError: null,
  });
  let inFlight = false;
  let disposed = false;

  function preparationMatches(): boolean {
    const preparation = preparationState();
    const current = state.value?.preparation;
    return Boolean(
      current?.status === "prepared" &&
        preparation.plan?.status === "prepared" &&
        current.planId === preparation.plan.id &&
        current.revision === preparation.revision,
    );
  }

  function apply(value: MigrationAssessmentState): void {
    if (disposed) return;
    setState((draft) => {
      draft.value = value;
      draft.ready = true;
      if (value.applicability === "current" && value.assessment) {
        const declaration = value.assessment.destination;
        draft.declaration = {
          ...declaration,
          appVersion: declaration.appVersion ?? "",
          schemaVersion: declaration.schemaVersion === null ? "" : String(declaration.schemaVersion),
        };
      }
    });
  }

  async function run(busy: "loading" | "assessing", action: () => Promise<MigrationAssessmentState>) {
    if (inFlight || disposed) return;
    inFlight = true;
    setState((draft) => {
      draft.busy = busy;
      draft.ready = false;
      draft.error = null;
      draft.validationError = null;
    });
    try {
      apply(await action());
    } catch {
      if (disposed) return;
      if (busy === "assessing") {
        try {
          apply(await calls.getState());
        } catch {
          // The user must reload before another mutation can use an authoritative revision.
        }
      }
      if (!disposed) {
        setState((draft) => {
          draft.error = currentText().t("migrationAssessment.failed");
        });
      }
    } finally {
      inFlight = false;
      if (!disposed) {
        setState((draft) => {
          draft.busy = null;
        });
      }
    }
  }

  function reload(): void {
    void run("loading", () => calls.getState());
  }

  function assess(): void {
    if (
      !canAssess() ||
      inFlight ||
      disposed ||
      !state.ready ||
      !preparationMatches() ||
      (state.value?.revision ?? 0) >= MIGRATION_ASSESSMENT_MAX_REVISION
    )
      return;
    const current = state.value;
    if (!current?.preparation) return;
    let input: MigrationAssessmentAssessInput;
    try {
      const schemaText = state.declaration.schemaVersion.trim();
      if (schemaText !== "" && !/^\d+$/u.test(schemaText)) throw new Error("Invalid schema version.");
      input = parseMigrationAssessmentAssessInput({
        planId: current.preparation.planId,
        expectedPreparationRevision: current.preparation.revision,
        expectedAssessmentRevision: current.revision,
        destination: {
          ...state.declaration,
          appVersion: state.declaration.appVersion.trim() || null,
          schemaVersion: schemaText === "" ? null : Number(schemaText),
        },
      });
    } catch {
      setState((draft) => {
        draft.validationError = currentText().t("migrationAssessment.validationFailed");
      });
      return;
    }
    void run("assessing", () => calls.assess(input));
  }

  function setDeclaration<Key extends keyof MigrationAssessmentDeclarationDraft>(
    key: Key,
    value: MigrationAssessmentDeclarationDraft[Key],
  ): void {
    if (!canAssess() || inFlight || disposed) return;
    setState((draft) => {
      draft.declaration[key] = value;
      draft.validationError = null;
    });
  }

  return {
    state,
    preparationMatches,
    reload,
    assess,
    setDeclaration,
    dispose: () => {
      disposed = true;
    },
  };
}
