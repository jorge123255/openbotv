import type { GrokBotComputerSummary } from "@openbot/contracts/ipc";
import { GrokBotComputerPane } from "@openbot/ui/features/grok-bot/GrokBotComputerPane";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore } from "solid-js";
import { appPort } from "../../app-port";
import { useConversationViewScope } from "./conversation-scope";

/**
 * Opens the Grok Bot computer window when the Browser pane is chosen, and shows its phase.
 * The screen URL and the network token stay in main.
 */
export function GrokBotSideComputer() {
  const { grokComputerOpenRequest } = useConversationViewScope();
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{
    computer: GrokBotComputerSummary | null;
    busy: boolean;
    error: string | null;
  }>({ computer: null, busy: false, error: null });
  let generation = 0;

  const run = (action: () => Promise<GrokBotComputerSummary>) => {
    const current = ++generation;
    setState((draft) => ({ ...draft, busy: true, error: null }));
    void action()
      .then((computer) => {
        if (current !== generation) return;
        setState((draft) => ({ ...draft, computer }));
      })
      .catch((error: unknown) => {
        if (current !== generation) return;
        setState((draft) => ({
          ...draft,
          error: errorMessage(error, t("conversation.sidePanel.grokComputer.failed")),
        }));
      })
      .finally(() => {
        if (current !== generation) return;
        setState((draft) => ({ ...draft, busy: false }));
      });
  };

  createEffect(
    () => grokComputerOpenRequest(),
    (request) => {
      if (request === 0) return;
      run(() => appPort().grokBot.openComputer());
    },
  );

  return (
    <GrokBotComputerPane
      computer={state.computer}
      busy={state.busy}
      error={state.error}
      onOpen={() => run(() => appPort().grokBot.openComputer())}
      onHandBack={() => run(() => appPort().grokBot.handBackComputer())}
    />
  );
}
