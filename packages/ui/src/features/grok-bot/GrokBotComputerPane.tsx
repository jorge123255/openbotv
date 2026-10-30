import type { GrokBotComputerSummary } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Show } from "solid-js";

export interface GrokBotComputerPaneProps {
  computer: GrokBotComputerSummary | null;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onHandBack: () => void;
}

/**
 * The Grok Bot computer in the chat side panel. The screen stays in the main-process window.
 * This pane only shows the phase and asks main to open that window or hand the computer back.
 */
export function GrokBotComputerPane(props: GrokBotComputerPaneProps) {
  const { t } = useText();
  const line = () => {
    const computer = props.computer;
    if (!computer)
      return props.busy ? t("server.settings.grokBotComputerStarting") : t("server.settings.grokBotComputerHint");
    switch (computer.phase) {
      case "pulling":
        return t("server.settings.grokBotComputerPulling", { percent: Math.round(computer.pullPercent ?? 0) });
      case "running":
        return t("server.settings.grokBotComputerRunning");
      case "sleeping":
        return t("server.settings.grokBotComputerSleeping");
      case "starting":
        return t("server.settings.grokBotComputerStarting");
      case "local":
        return t("server.settings.grokBotComputerNoScreen");
      case "off":
        return t("server.settings.grokBotComputerOff");
    }
  };
  return (
    <aside class="browser-panel grok-bot-side-pane" aria-label={t("server.settings.grokBotComputer")}>
      <div class="grok-bot-side-body">
        <h2 class="grok-bot-side-title">{t("server.settings.grokBotComputer")}</h2>
        <p class="grok-bot-side-copy">{line()}</p>
        <Show when={props.computer?.windowOpen}>
          <p class="grok-bot-side-copy">{t("conversation.sidePanel.grokComputer.window")}</p>
        </Show>
        <Show when={props.computer?.needsYou}>
          <p class="grok-bot-side-copy">
            {props.computer?.handoffReason ?? t("server.settings.grokBotComputerNeedsYou")}
          </p>
        </Show>
        <Show when={props.error}>{(error) => <p class="grok-bot-side-error">{error()}</p>}</Show>
        <div class="grok-bot-side-actions">
          <Button variant="secondary" type="button" disabled={props.busy} onClick={() => props.onOpen()}>
            {t("server.settings.grokBotComputerOpen")}
          </Button>
          <Show when={props.computer?.needsYou}>
            <Button variant="secondary" type="button" disabled={props.busy} onClick={() => props.onHandBack()}>
              {t("server.settings.grokBotComputerHandBack")}
            </Button>
          </Show>
        </div>
      </div>
    </aside>
  );
}
