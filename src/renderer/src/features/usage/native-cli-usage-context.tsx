import type { ConnectKimiCliUsageInput, KimiCliUsageSnapshot } from "@openbot/contracts/ipc";
import { createStore, onSettled, reconcile } from "solid-js";
import { createSimpleContext } from "../../simple-context";
import { nativeCliUsagePort } from "./native-cli-usage-port";

/** Machine-local cache only. Timers never call a CLI or its HTTP API. */
const context = createSimpleContext({
  name: "Native CLI usage",
  init: () => {
    const [state, setState] = createStore<{
      reading: KimiCliUsageSnapshot | null;
      now: number;
      busy: boolean;
      error: boolean;
    }>({ reading: null, now: Date.now(), busy: false, error: false });
    let epoch = 0;
    let pending = false;
    function accept(reading: KimiCliUsageSnapshot): void {
      setState((draft) => {
        if (draft.reading) reconcile(reading, "id")(draft.reading);
        else draft.reading = reading;
        draft.now = Date.now();
      });
    }
    async function cached(): Promise<void> {
      const generation = epoch;
      const reading = await nativeCliUsagePort()
        .kimiCliUsage?.get()
        .catch(() => null);
      if (reading && generation === epoch) accept(reading);
    }
    async function perform(action: () => Promise<KimiCliUsageSnapshot>): Promise<void> {
      if (pending) return;
      pending = true;
      const generation = ++epoch;
      setState((draft) => {
        draft.busy = true;
        draft.error = false;
      });
      try {
        const reading = await action();
        if (generation === epoch) accept(reading);
      } catch {
        if (generation === epoch)
          setState((draft) => {
            draft.error = true;
            draft.reading = null;
          });
      } finally {
        pending = false;
        setState((draft) => {
          draft.busy = false;
        });
      }
    }
    onSettled(() => {
      void cached();
      const timer = setInterval(() => {
        setState((draft) => {
          draft.now = Date.now();
        });
        if (!pending) void cached();
      }, 15_000);
      return () => {
        epoch++;
        clearInterval(timer);
      };
    });
    return {
      state,
      connect: (input: ConnectKimiCliUsageInput) => perform(() => nativeCliUsagePort().kimiCliUsage.connect(input)),
      read: () => perform(() => nativeCliUsagePort().kimiCliUsage.read({ allowRefresh: true })),
      async disconnect(): Promise<void> {
        ++epoch;
        const reading = await nativeCliUsagePort()
          .kimiCliUsage.disconnect()
          .catch(() => null);
        if (reading) accept(reading);
        else
          setState((draft) => {
            draft.reading = null;
            draft.error = true;
          });
      },
    };
  },
});

export const NativeCliUsageProvider = context.provider;
export const useNativeCliUsage = context.use;
