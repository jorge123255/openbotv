import type { ChannelPage, ChannelTask } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { ChannelStoppedTaskView } from "@openbot/ui/features/channels/ChannelStoppedTasks";
import { stoppedChannelTasks } from "./channel-conversation-rows";

function reason(task: ChannelTask): ChannelStoppedTaskView["reason"] {
  if (task.state === "failed") return "uncertain";
  if (task.error === sourceText("error.backend.channelTaskStopped")) return "stopped";
  if (task.error === sourceText("error.backend.channelTaskDependencyCancelled")) return "dependency";
  if (task.error === "The automatic assignment limit was reached. Continue or reassign this task.") return "limit";
  if (
    task.error === sourceText("error.backend.channelAssigneeReassign") ||
    task.error === sourceText("error.backend.channelMemberUnavailable")
  )
    return "unavailable";
  return "uncertain";
}

/** Derives display-only labels and the review's available history; no model or provider call. */
export function channelTaskAttention(page: ChannelPage): ChannelStoppedTaskView[] {
  return stoppedChannelTasks(page).map((task) => {
    const ids = new Set([task.id]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const item of page.tasks)
        if (item.parentTaskId && ids.has(item.parentTaskId) && !ids.has(item.id)) {
          ids.add(item.id);
          changed = true;
        }
    }
    const branch = page.tasks.filter((item) => ids.has(item.id));
    const requests = new Set(branch.map((item) => item.requestMessageId));
    const entries = page.messages.filter((entry) => (entry.taskId && ids.has(entry.taskId)) || requests.has(entry.id));
    const lastActivityAt = entries.at(-1)?.message.createdAt ?? null;
    const why = reason(task);
    return {
      id: task.id,
      ownerAgentId: task.ownerAgentId,
      instruction: task.instruction,
      error: task.error,
      revision: task.revision,
      channelRevision: page.channel.revision,
      reason: why,
      requiresReview: branch.some(
        (item) =>
          item.state !== "completed" &&
          item.state !== "cancelled" &&
          (reason(item) === "uncertain" || reason(item) === "dependency"),
      ),
      lastActivityAt: lastActivityAt && Number.isFinite(Date.parse(lastActivityAt)) ? lastActivityAt : null,
      unfinishedSubtasks: branch.filter(
        (item) => item.id !== task.id && item.state !== "completed" && item.state !== "cancelled",
      ).length,
      historyComplete: page.olderCursor === null,
      history: entries.map((entry) => ({
        id: entry.id,
        author: entry.author.name,
        text: entry.message.text,
        at: entry.message.createdAt,
        details: JSON.stringify(entry, null, 2),
      })),
    };
  });
}
