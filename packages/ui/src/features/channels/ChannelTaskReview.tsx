import { Button, Dialog } from "@openbot/ui";
import { createStore, For, Show } from "solid-js";
import { useText } from "../../text";
import type { ChannelStoppedTaskView } from "./ChannelStoppedTasks";

/** Read-only activity review. Acknowledgment is tied to the caller's task/channel revision. */
export function ChannelTaskReview(props: {
  task: ChannelStoppedTaskView;
  stale: boolean;
  onClose: () => void;
  onReviewed: () => void;
  onLoadOlder?: (() => Promise<void>) | undefined;
}) {
  const { t, format } = useText();
  const [state, setState] = createStore({ loading: false });
  async function load() {
    if (state.loading) return;
    setState((state) => {
      state.loading = true;
    });
    try {
      await props.onLoadOlder?.();
    } finally {
      setState((state) => {
        state.loading = false;
      });
    }
  }
  const summary = (text: string) => {
    const trimmed = text.trim();
    return !trimmed || trimmed.startsWith("{") || trimmed.startsWith("[") ? t("channel.stoppedTask.event") : trimmed;
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay>
          <Dialog.Content class="channel-task-review">
            <Dialog.Title as="h2">{t("channel.stoppedTask.reviewTitle")}</Dialog.Title>
            <Dialog.Description>{t("channel.stoppedTask.reviewDescription")}</Dialog.Description>
            <Show when={props.stale}>
              <p role="alert">{t("channel.stoppedTask.changed")}</p>
            </Show>
            <div class="channel-task-review-history">
              <h3>{t("channel.stoppedTask.request")}</h3>
              <p class="channel-task-review-request">{props.task.instruction}</p>
              <Show when={!props.task.historyComplete}>
                <p>{t("channel.stoppedTask.earlierActivity")}</p>
                <Show when={props.onLoadOlder}>
                  <Button size="sm" loading={state.loading} onClick={() => void load()}>
                    {t("channel.stoppedTask.loadEarlier")}
                  </Button>
                </Show>
              </Show>
              <For each={props.task.history} fallback={<p>{t("channel.stoppedTask.noActivity")}</p>}>
                {(entry) => (
                  <section class="channel-task-review-entry">
                    <header>
                      <strong>{entry.author}</strong>
                      <time datetime={entry.at}>
                        {Number.isFinite(Date.parse(entry.at))
                          ? format.date(new Date(entry.at), { dateStyle: "short", timeStyle: "short" })
                          : t("channel.stoppedTask.timeUnknown")}
                      </time>
                    </header>
                    <p>{summary(entry.text)}</p>
                    <details class="channel-task-event-details">
                      <summary>{t("channel.stoppedTask.details")}</summary>
                      <pre>{entry.details}</pre>
                    </details>
                  </section>
                )}
              </For>
            </div>
            <footer>
              <Button variant="ghost" onClick={() => props.onClose()}>
                {t("common.close")}
              </Button>
              <Button
                disabled={props.stale || !props.task.historyComplete || state.loading}
                onClick={() => props.onReviewed()}
              >
                {t("channel.stoppedTask.reviewed")}
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
