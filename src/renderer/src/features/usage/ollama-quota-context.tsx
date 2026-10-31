import type { OllamaQuotaSnapshot } from "@openbot/contracts/ipc";
import { createStore, onSettled, reconcile } from "solid-js";
import { createSimpleContext } from "../../simple-context";
import { ollamaQuotaPort } from "./ollama-quota-port";

/** Machine-local reads survive server switches; only mounted local conversations subscribe. */
const context = createSimpleContext({
  name: "Ollama quota",
  init: () => {
    const [state, setState] = createStore<{ readings: Record<string, OllamaQuotaSnapshot | null>; now: number }>({
      readings: {},
      now: Date.now(),
    });
    const watched = new Map<string, number>();
    const pending = new Map<string, Promise<OllamaQuotaSnapshot | null>>();
    let epoch = 0;

    function refresh(agentId: string): Promise<OllamaQuotaSnapshot | null> {
      const existing = pending.get(agentId);
      if (existing) return existing;
      const generation = epoch;
      const request = (ollamaQuotaPort().ollamaQuota?.read(agentId) ?? Promise.resolve(null))
        .catch(() => null)
        .then((reading) => {
          if (generation !== epoch) return null;
          setState((draft) => {
            const previous = draft.readings[agentId];
            if (previous && reading) reconcile(reading, "id")(previous);
            else draft.readings[agentId] = reading;
            draft.now = Date.now();
          });
          return reading;
        })
        .finally(() => {
          if (pending.get(agentId) === request) pending.delete(agentId);
        });
      pending.set(agentId, request);
      return request;
    }

    function tick(): void {
      setState((draft) => {
        draft.now = Date.now();
      });
      if (document.visibilityState === "hidden") return;
      for (const id of watched.keys()) void refresh(id);
    }

    function clear(): void {
      epoch++;
      pending.clear();
      setState((draft) => {
        draft.readings = {};
      });
      tick();
    }

    onSettled(() => {
      const unsubscribe = ollamaQuotaPort().ollamaQuota?.onChanged(clear);
      const timer = setInterval(tick, 15_000);
      document.addEventListener("visibilitychange", tick);
      return () => {
        epoch++;
        unsubscribe?.();
        clearInterval(timer);
        document.removeEventListener("visibilitychange", tick);
      };
    });

    return {
      state,
      refresh,
      watch(agentId: string): () => void {
        watched.set(agentId, (watched.get(agentId) ?? 0) + 1);
        void refresh(agentId);
        return () => {
          const count = (watched.get(agentId) ?? 1) - 1;
          if (count) watched.set(agentId, count);
          else watched.delete(agentId);
        };
      },
      async dismiss(ids: readonly string[]): Promise<void> {
        // Hide immediately in this window; main owns the shared episode across windows.
        setState((draft) => {
          for (const reading of Object.values(draft.readings))
            for (const window of reading?.windows ?? [])
              if (window.warningId && ids.includes(window.warningId)) window.warningId = null;
        });
        await Promise.all(ids.map((id) => ollamaQuotaPort().ollamaQuota.dismiss(id)));
      },
    };
  },
});

export const OllamaQuotaProvider = context.provider;
export const useOllamaQuota = context.use;
