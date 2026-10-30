import { useText } from "@openbot/ui/text";

/**
 * Grok Bot has no file list in this port. The files stay on the sand computer.
 * Open Browser shows that computer.
 */
export function GrokBotFilesPane() {
  const { t } = useText();
  return (
    <aside class="browser-panel grok-bot-side-pane" aria-label={t("conversation.sidePanel.pane.files")}>
      <div class="grok-bot-side-body">
        <h2 class="grok-bot-side-title">{t("conversation.sidePanel.pane.files")}</h2>
        <p class="grok-bot-side-copy">{t("conversation.sidePanel.grokFiles.body")}</p>
      </div>
    </aside>
  );
}
