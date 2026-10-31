import type { MigrationPreparationState } from "@openbot/contracts/ipc";
import type { MigrationDestinationPolicyState } from "@openbot/contracts/ipc-migration-destination-policy";
import { currentText } from "@openbot/ui/text";
import { createStore, reconcile, untrack } from "solid-js";
import type { MigrationDestinationPolicyCalls } from "./migration-destination-policy-port";

interface PolicyViewState {
  value: MigrationDestinationPolicyState | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
}

/** Each read is bound to the prepared Docker plan that started it. No evidence is admitted here. */
export function createMigrationDestinationPolicyStore(
  calls: MigrationDestinationPolicyCalls,
  preparationState: () => MigrationPreparationState,
  isAvailable: () => boolean,
) {
  const [state, setState] = createStore<PolicyViewState>({ value: null, loading: false, stale: false, error: null });
  let inFlight = false;
  let disposed = false;

  function eligiblePreparation() {
    const preparation = preparationState();
    return isAvailable() &&
      preparation.plan?.status === "prepared" &&
      preparation.plan.destinationKind === "docker-host"
      ? { planId: preparation.plan.id, revision: preparation.revision }
      : null;
  }

  function preparationMatches(): boolean {
    const current = eligiblePreparation();
    const binding = state.value?.preparation;
    return Boolean(
      current &&
        binding?.status === "prepared" &&
        binding.destinationKind === "docker-host" &&
        state.value?.applicability === "current" &&
        state.value.phase === "blocked" &&
        current.planId === binding.planId &&
        current.revision === binding.revision,
    );
  }

  async function reload(): Promise<void> {
    if (disposed || inFlight) return;
    const before = untrack(eligiblePreparation);
    if (!before) return;
    inFlight = true;
    setState((draft) => {
      draft.loading = true;
      draft.error = null;
      draft.value = null;
      draft.stale = false;
    });
    try {
      const value = await calls.getState();
      if (disposed || !untrack(isAvailable)) return;
      const after = untrack(eligiblePreparation);
      const binding = value.preparation;
      const current = Boolean(
        after &&
          after.planId === before.planId &&
          after.revision === before.revision &&
          binding?.status === "prepared" &&
          binding.destinationKind === "docker-host" &&
          binding.planId === before.planId &&
          binding.revision === before.revision &&
          value.applicability === "current" &&
          value.phase === "blocked",
      );
      setState(reconcile({ value: current ? value : null, loading: false, stale: !current, error: null }));
    } catch {
      if (!disposed && untrack(isAvailable)) {
        setState((draft) => {
          draft.error = currentText().t("error.migration.destinationPolicyReadFailed");
        });
      }
    } finally {
      inFlight = false;
      if (!disposed)
        setState((draft) => {
          draft.loading = false;
        });
    }
  }

  return {
    state,
    preparationMatches,
    reload: () => {
      void reload();
    },
    dispose: () => {
      disposed = true;
    },
  };
}
