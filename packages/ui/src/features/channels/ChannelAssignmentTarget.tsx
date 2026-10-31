import { Button, Dialog } from "@openbot/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { AgentProfile, ChannelAssignmentTask } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";

const STATES = {
  queued: "channel.task.state.queued",
  running: "channel.task.state.running",
  waiting: "channel.task.state.waiting",
  paused: "channel.task.state.paused",
  completed: "channel.task.state.completed",
  failed: "channel.task.state.failed",
  cancelled: "channel.task.state.cancelled",
} as const;
const REASONS = {
  queued: "channel.task.reason.queued",
  running: "channel.task.reason.running",
  waiting: "channel.task.reason.waiting",
  paused: "channel.task.reason.paused",
  completed: "channel.task.reason.completed",
  failed: "channel.task.reason.failed",
  cancelled: "channel.task.reason.cancelled",
} as const;

/** The routing receipt opens its channel work, not the recipient's separate private chat. */
export function ChannelAssignmentTarget(props: {
  agent: AgentProfile | undefined;
  targetAgentId: string;
  task: ChannelAssignmentTask | undefined;
}) {
  const { t, format, sourceText } = useText();
  const [open, setOpen] = createSignal(false);
  const statusId = createUniqueId();
  const name = () => props.agent?.name ?? t("chat.marker.unavailableAgent");
  const time = (at: string) => format.date(new Date(at), { dateStyle: "short", timeStyle: "short" });
  return (
    <>
      <Button
        variant="ghost"
        type="button"
        class="chat-action-target channel-assignment-target"
        aria-label={t("channel.task.open", {
          name: name(),
          task: props.task?.instruction.split(/\r?\n/, 1)[0]?.slice(0, 100) ?? t("channel.task.title"),
        })}
        aria-describedby={props.task ? statusId : undefined}
        onClick={() => setOpen(true)}
      >
        <AgentAvatar agent={props.agent} class="chat-action-agent-avatar" />
        <span>{name()}</span>
        <Show when={props.task}>
          {(task) => (
            <span id={statusId} class="channel-assignment-state">
              {task().ownerAgentId === props.targetAgentId ? t(STATES[task().state]) : t("channel.task.reassigned")}
            </span>
          )}
        </Show>
      </Button>
      <Dialog.Root open={open()} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay>
            <Dialog.Content class="channel-task-review">
              <Dialog.Title as="h2">{t("channel.task.title")}</Dialog.Title>
              <Dialog.Description>{t("channel.task.location")}</Dialog.Description>
              <Show when={props.task} fallback={<p>{t("channel.task.unavailable")}</p>}>
                {(task) => (
                  <div class="channel-task-review-history">
                    <p class="channel-assignment-context">
                      {task().channelName} · {task().ownerName}
                    </p>
                    <p role="status">
                      <strong>{t(STATES[task().state])}</strong> — {t(REASONS[task().state])}
                    </p>
                    <Show when={task().error}>{(error) => <p>{sourceText(error())}</p>}</Show>
                    <h3>{t("channel.stoppedTask.request")}</h3>
                    <p class="channel-task-review-request">{task().instruction}</p>
                    <Show when={task().lastActivityAt}>
                      {(at) => <p>{t("channel.stoppedTask.lastActivity", { time: time(at()) })}</p>}
                    </Show>
                    <details class="channel-task-event-details">
                      <summary>{t("channel.task.reference")}</summary>
                      <code>{task().id}</code>
                    </details>
                    <h3>{t("channel.task.activity")}</h3>
                    <Show when={task().earlierActivity}>
                      <p>{t("channel.task.earlier")}</p>
                    </Show>
                    <For each={task().activity} fallback={<p>{t("channel.task.noActivity")}</p>}>
                      {(entry) => (
                        <section class="channel-task-review-entry">
                          <header>
                            <strong>{entry.author}</strong>
                            <Show when={Number.isFinite(Date.parse(entry.at))}>
                              <time datetime={entry.at}>{time(entry.at)}</time>
                            </Show>
                          </header>
                          <Show when={entry.attachments > 0}>
                            <p>{t("channel.task.attachments", { count: entry.attachments })}</p>
                          </Show>
                          <Show when={!entry.text.trim() && entry.attachments === 0}>
                            <p>{t("channel.stoppedTask.event")}</p>
                          </Show>
                          <Show
                            when={!entry.text.trim().startsWith("{") && !entry.text.trim().startsWith("[")}
                            fallback={
                              <details class="channel-task-event-details">
                                <summary>{t("channel.stoppedTask.details")}</summary>
                                <pre>{entry.text}</pre>
                              </details>
                            }
                          >
                            <p class="channel-task-review-request">{entry.text}</p>
                          </Show>
                        </section>
                      )}
                    </For>
                  </div>
                )}
              </Show>
              <footer>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {t("common.close")}
                </Button>
              </footer>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
