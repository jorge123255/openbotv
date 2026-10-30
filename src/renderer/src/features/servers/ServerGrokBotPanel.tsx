import type { GrokBotAgentSummary, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { GrokBotAccountPanel } from "@openbot/ui/features/grok-bot/GrokBotAccountPanel";
import { createEffect, createStore } from "solid-js";

export interface ServerGrokBotOptions {
  api: OpenBotDesktopApi["grokBot"];
  openUrl: (url: string) => Promise<void>;
}

/** Desktop wiring for the Grok Bot account. The panel stays free of `window.openbot`. */
export function ServerGrokBotPanel(props: ServerGrokBotOptions) {
  const initial: {
    signedIn: boolean;
    agents: GrokBotAgentSummary[];
    error: string | null;
    busy: boolean;
  } = { signedIn: false, agents: [], error: null, busy: false };
  const [state, setState] = createStore(initial);

  const load = async (api: OpenBotDesktopApi["grokBot"]) => {
    const status = await api.getStatus();
    if (!status.signedIn) {
      setState((current) => ({ ...current, signedIn: false, agents: [], error: null }));
      return;
    }
    const agents = await api.listAgents();
    setState((current) => ({ ...current, signedIn: true, agents: [...agents], error: null }));
  };

  createEffect(
    () => props.api,
    (api) => {
      void load(api);
      const stop = api.onAccount((event) => {
        if (event.phase === "signed-out") {
          setState((current) => ({ ...current, signedIn: false, agents: [], error: null, busy: false }));
          return;
        }
        if (event.phase === "failed") {
          setState((current) => ({ ...current, error: event.message, busy: false }));
          return;
        }
        void load(api);
      });
      return () => stop();
    },
  );

  return (
    <GrokBotAccountPanel
      signedIn={state.signedIn}
      agents={state.agents}
      busy={state.busy}
      error={state.error}
      onSignIn={() => {
        const api = props.api;
        const openUrl = props.openUrl;
        setState((current) => ({ ...current, busy: true, error: null }));
        void api
          .startSignIn()
          .then((started) => openUrl(started.verificationUrl))
          .catch((error: unknown) => {
            setState((current) => ({
              ...current,
              error: error instanceof Error ? error.message : null,
            }));
          })
          .finally(() => setState((current) => ({ ...current, busy: false })));
      }}
      onSignOut={() => {
        const api = props.api;
        setState((current) => ({ ...current, busy: true, error: null }));
        void api
          .signOut()
          .catch((error: unknown) => {
            setState((current) => ({
              ...current,
              error: error instanceof Error ? error.message : null,
            }));
          })
          .finally(() => setState((current) => ({ ...current, busy: false })));
      }}
      onRefresh={() => {
        void load(props.api);
      }}
      onCreate={(input) => {
        const api = props.api;
        setState((current) => ({ ...current, busy: true, error: null }));
        void api
          .createAgent(input)
          .then((agent) => {
            setState((current) => ({ ...current, signedIn: true, agents: [...current.agents, agent] }));
          })
          .catch((error: unknown) => {
            setState((current) => ({
              ...current,
              error: error instanceof Error ? error.message : null,
            }));
          })
          .finally(() => setState((current) => ({ ...current, busy: false })));
      }}
    />
  );
}
