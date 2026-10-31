import type { ChannelMember } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button, buttonVariants, CircleX, ConfirmDialog, DropdownMenu } from "@openbot/ui";
import { createStore, For, Show } from "solid-js";
import { useText } from "../../text";
import { ChannelTaskReview } from "./ChannelTaskReview";

export interface ChannelStoppedTaskView {
  id: string;
  ownerAgentId: string | null;
  instruction: string;
  error: string | null;
  revision: number;
  channelRevision: number;
  reason: "stopped" | "limit" | "unavailable" | "uncertain" | "dependency";
  requiresReview: boolean;
  lastActivityAt: string | null;
  unfinishedSubtasks: number;
  historyComplete: boolean;
  history: { id: string; author: string; text: string; at: string; details: string }[];
}

const REASONS = {
  stopped: "channel.stoppedTask.reasonStopped",
  limit: "channel.stoppedTask.reasonLimit",
  unavailable: "channel.stoppedTask.reasonUnavailable",
  uncertain: "channel.stoppedTask.reasonUncertain",
  dependency: "channel.stoppedTask.reasonDependency",
} as const satisfies Record<ChannelStoppedTaskView["reason"], AppTextKey>;

function stoppedTaskTitle(instruction: string, fallback: string): string {
  const first = instruction
    .trim()
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim();
  if (!first || first.startsWith("{") || first.startsWith("[")) return fallback;
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
}

/** One selectable card per stopped task. A root action also affects its unfinished descendants. */
export function ChannelStoppedTasks(props: {
  tasks: ChannelStoppedTaskView[];
  members: Pick<ChannelMember, "agentId">[];
  name: (agentId: string | null) => string;
  actionsSupported: boolean;
  pending?: boolean;
  onResume: (task: ChannelStoppedTaskView, recipientAgentId: string | null) => Promise<boolean>;
  onCancel: (task: ChannelStoppedTaskView) => Promise<boolean>;
  onLoadOlder?: (() => Promise<void>) | undefined;
}) {
  const { t, format } = useText();
  const [state, setState] = createStore<{
    reviewed: Record<string, string>;
    dialog: { kind: "review" | "cancel"; task: ChannelStoppedTaskView } | null;
    running: boolean;
    error: string | null;
  }>({ reviewed: {}, dialog: null, running: false, error: null });
  let inFlight = false;
  let menuTask: ChannelStoppedTaskView | null = null;
  const stamp = (task: ChannelStoppedTaskView) => `${task.revision}:${task.channelRevision}`;
  const current = () => props.tasks.find((task) => task.id === state.dialog?.task.id);
  const stale = () => {
    const latest = current();
    const snapshot = state.dialog?.task;
    return !latest || !snapshot || stamp(latest) !== stamp(snapshot);
  };
  const reviewed = (task: ChannelStoppedTaskView) => !task.requiresReview || state.reviewed[task.id] === stamp(task);
  const disabled = () => props.pending || state.running || !props.actionsSupported;
  const title = (task: ChannelStoppedTaskView) =>
    stoppedTaskTitle(task.instruction, t("channel.stoppedTask.unknownTitle"));

  async function act(task: ChannelStoppedTaskView, action: () => Promise<boolean>, requireAcknowledgment = false) {
    if (inFlight || disabled()) return;
    const latest = props.tasks.find((item) => item.id === task.id);
    if (!latest || stamp(latest) !== stamp(task) || (requireAcknowledgment && !reviewed(task))) {
      setState((state) => {
        state.error = t("channel.stoppedTask.changed");
      });
      return;
    }
    inFlight = true;
    setState((state) => {
      state.running = true;
      state.error = null;
    });
    try {
      const accepted = await action();
      setState((state) => {
        if (accepted) state.dialog = null;
        else state.error = t("channel.stoppedTask.actionFailed");
      });
    } catch {
      setState((state) => {
        state.error = t("channel.stoppedTask.actionFailed");
      });
    } finally {
      inFlight = false;
      setState((state) => {
        state.running = false;
      });
    }
  }
  const open = (kind: "review" | "cancel", task: ChannelStoppedTaskView) =>
    setState((state) => {
      state.dialog = { kind, task };
      state.error = null;
    });
  const close = () =>
    setState((state) => {
      state.dialog = null;
      state.error = null;
    });

  return (
    <Show when={props.tasks.length}>
      <details class="channel-paused-tasks">
        <summary class="channel-paused-summary">
          {t("channel.stoppedTask.attention", { count: props.tasks.length })}
        </summary>
        <Show when={state.error}>
          <p role="alert" class="channel-paused-error">
            {state.error}
          </p>
        </Show>
        <Show when={!props.actionsSupported}>
          <p class="channel-paused-error">{t("channel.stoppedTask.updateHost")}</p>
        </Show>
        <For each={props.tasks.map((task) => task.id)}>
          {(id) => (
            <Show when={props.tasks.find((task) => task.id === id)}>
              {(task) => (
                <details class="channel-paused-task" aria-label={title(task())}>
                  <summary
                    class="channel-paused-task-heading"
                    aria-label={`${title(task())}, ${t("channel.stoppedTask.label", { name: props.name(task().ownerAgentId) })}`}
                  >
                    <strong>{title(task())}</strong>
                    <span>{props.name(task().ownerAgentId)}</span>
                    <span>
                      {task().lastActivityAt
                        ? t("channel.stoppedTask.lastActivity", {
                            time: format.date(new Date(task().lastActivityAt ?? ""), {
                              dateStyle: "short",
                              timeStyle: "short",
                            }),
                          })
                        : t("channel.stoppedTask.timeUnknown")}
                    </span>
                  </summary>
                  <div class="channel-paused-task-body">
                    <p class="channel-paused-task-reason">{t(REASONS[task().reason])}</p>
                    <Show when={task().unfinishedSubtasks > 0}>
                      <p>{t("channel.stoppedTask.subtasks", { count: task().unfinishedSubtasks })}</p>
                    </Show>
                    <div class="channel-paused-task-actions">
                      <Button size="xs" variant="ghost" onClick={() => open("review", task())}>
                        {t("channel.stoppedTask.review")}
                      </Button>
                      <Show
                        when={
                          !task().ownerAgentId || props.members.some((member) => member.agentId === task().ownerAgentId)
                        }
                      >
                        <Button
                          size="xs"
                          disabled={disabled() || !reviewed(task())}
                          onClick={() => void act(task(), () => props.onResume(task(), null), true)}
                        >
                          {t("common.continue")}
                        </Button>
                      </Show>
                      <DropdownMenu.Root
                        placement="top-start"
                        onOpenChange={(open) => {
                          if (open) menuTask = task();
                        }}
                      >
                        <DropdownMenu.Trigger
                          class={buttonVariants({ variant: "ghost", size: "xs" })}
                          disabled={
                            disabled() ||
                            !reviewed(task()) ||
                            !props.members.some((member) => member.agentId !== task().ownerAgentId)
                          }
                          aria-label={t("channel.stoppedTask.reassignLabel", { name: props.name(task().ownerAgentId) })}
                        >
                          {t("channel.stoppedTask.reassign")}
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content>
                            <For each={props.members.filter((member) => member.agentId !== task().ownerAgentId)}>
                              {(member) => (
                                <DropdownMenu.Item
                                  disabled={disabled() || !reviewed(task())}
                                  onSelect={() => {
                                    const snapshot = menuTask;
                                    if (snapshot?.id === id)
                                      void act(snapshot, () => props.onResume(snapshot, member.agentId), true);
                                  }}
                                >
                                  {props.name(member.agentId)}
                                </DropdownMenu.Item>
                              )}
                            </For>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                      <Button size="xs" variant="ghost" disabled={disabled()} onClick={() => open("cancel", task())}>
                        {t("channel.stoppedTask.cancel")}
                      </Button>
                    </div>
                    <details class="channel-task-event-details">
                      <summary>{t("channel.stoppedTask.details")}</summary>
                      <pre>{task().error}</pre>
                      <pre>{task().instruction}</pre>
                      <code>{task().id}</code>
                    </details>
                  </div>
                </details>
              )}
            </Show>
          )}
        </For>
      </details>
      <Show when={state.dialog?.kind === "review" ? state.dialog.task : null}>
        {(snapshot) => (
          <ChannelTaskReview
            task={current() ?? snapshot()}
            stale={stale()}
            onClose={close}
            onLoadOlder={props.onLoadOlder}
            onReviewed={() => {
              const latest = current();
              if (!latest || stale() || !latest.historyComplete) return;
              setState((state) => {
                state.reviewed[latest.id] = stamp(latest);
                state.dialog = null;
              });
            }}
          />
        )}
      </Show>
      <Show when={state.dialog?.kind === "cancel" ? state.dialog.task : null}>
        {(task) => (
          <ConfirmDialog
            open
            tone="default"
            icon={<CircleX />}
            initialFocus="cancel"
            title={t("channel.stoppedTask.cancelTitle")}
            description={t("channel.stoppedTask.cancelDescription")}
            confirmLabel={t("channel.stoppedTask.cancel")}
            cancelLabel={stale() ? t("common.close") : t("channel.stoppedTask.keep")}
            error={stale() ? t("channel.stoppedTask.changed") : (state.error ?? undefined)}
            onCancel={close}
            onConfirm={() => act(task(), () => props.onCancel(task()))}
          >
            <strong>{title(task())}</strong>
            <p>{props.name(task().ownerAgentId)}</p>
            <Show when={task().unfinishedSubtasks > 0}>
              <p>{t("channel.stoppedTask.subtasks", { count: task().unfinishedSubtasks })}</p>
            </Show>
          </ConfirmDialog>
        )}
      </Show>
    </Show>
  );
}
