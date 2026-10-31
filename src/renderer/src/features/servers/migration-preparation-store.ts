import type { MigrationPreparationDestinationKind, MigrationPreparationState } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createStore } from "solid-js";
import type { MigrationPreparationCalls } from "./migration-preparation-port";

type MigrationPreparationBusy = "loading" | "preparing" | "cancelling" | null;

interface PreparationViewState {
  value: MigrationPreparationState | null;
  destinationKind: MigrationPreparationDestinationKind;
  busy: MigrationPreparationBusy;
  ready: boolean;
  error: string | null;
}

/** The bridge owns persistence. The renderer never retries a mutation after an uncertain result. */
export function createMigrationPreparationStore(calls: MigrationPreparationCalls) {
  const [state, setState] = createStore<PreparationViewState>({
    value: null,
    destinationKind: "local-desktop",
    busy: null,
    ready: false,
    error: null,
  });
  let inFlight = false;
  let disposed = false;

  function apply(value: MigrationPreparationState): void {
    if (disposed) return;
    setState((draft) => {
      draft.value = value;
      draft.ready = true;
      if (value.plan) draft.destinationKind = value.plan.destinationKind;
    });
  }

  async function run(busy: Exclude<MigrationPreparationBusy, null>, action: () => Promise<MigrationPreparationState>) {
    if (inFlight || disposed) return;
    inFlight = true;
    setState((draft) => {
      draft.busy = busy;
      draft.ready = false;
      draft.error = null;
    });
    try {
      apply(await action());
    } catch {
      if (disposed) return;
      // A refusal or lost response may leave a newer journal revision. Read it; do not replay.
      if (busy !== "loading") {
        try {
          apply(await calls.getState());
        } catch {
          // Keep actions disabled until a later explicit reload succeeds.
        }
      }
      if (!disposed) {
        setState((draft) => {
          draft.error = currentText().t("error.migration.preparationFailed");
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

  function prepare(): void {
    const value = state.value;
    if (!state.ready || !value || value.plan?.status === "prepared") return;
    const input = { destinationKind: state.destinationKind, expectedRevision: value.revision };
    void run("preparing", () => calls.prepare(input));
  }

  function cancel(): void {
    const value = state.value;
    if (!state.ready || !value || value.plan?.status !== "prepared") return;
    const input = { planId: value.plan.id, expectedRevision: value.revision };
    void run("cancelling", () => calls.cancel(input));
  }

  function setDestination(destinationKind: MigrationPreparationDestinationKind): void {
    if (inFlight || disposed || state.value?.plan?.status === "prepared") return;
    setState((draft) => {
      draft.destinationKind = destinationKind;
    });
  }

  return {
    state,
    reload,
    prepare,
    cancel,
    setDestination,
    dispose: () => {
      disposed = true;
    },
  };
}
