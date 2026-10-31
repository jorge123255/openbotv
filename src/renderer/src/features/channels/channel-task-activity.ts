import { type ChannelPage, channelRoutingConversationEvent } from "@openbot/contracts/ipc";
import type { AgentProfile, ChannelAssignmentTask } from "@openbot/ui/data";

/** Current task state and recent channel activity, without opening a provider or private chat. */
export function channelTaskActivity(
  page: ChannelPage,
  agents: readonly AgentProfile[],
  names: { unassigned: string; unavailable: string },
): ReadonlyMap<string, ChannelAssignmentTask> {
  const visibleTasks = new Set(
    page.messages.filter((entry) => channelRoutingConversationEvent(entry.message)).map((entry) => entry.taskId),
  );
  return new Map(
    page.tasks
      .filter((task) => visibleTasks.has(task.id))
      .map((task) => {
        const entries = page.messages.filter(
          (entry) => !entry.superseded && entry.taskId === task.id && !channelRoutingConversationEvent(entry.message),
        );
        const activity = entries.filter(
          (entry) =>
            entry.id !== task.requestMessageId &&
            (entry.message.text.trim() || entry.message.attachments?.length || entry.message.questionPrompt),
        );
        const last = entries.at(-1)?.message.createdAt ?? null;
        const owner = agents.find((agent) => agent.id === task.ownerAgentId);
        return [
          task.id,
          {
            id: task.id,
            channelName: page.channel.name,
            ownerAgentId: task.ownerAgentId,
            ownerName:
              owner?.name ??
              entries.find((entry) => entry.author.id === task.ownerAgentId)?.author.name ??
              (task.ownerAgentId ? names.unavailable : names.unassigned),
            instruction: task.instruction,
            state: task.state,
            error: task.error,
            lastActivityAt: last && Number.isFinite(Date.parse(last)) ? last : null,
            earlierActivity: page.olderCursor !== null || activity.length > 8,
            activity: activity.slice(-8).map((entry) => ({
              id: entry.id,
              author: entry.author.name,
              text: entry.message.text,
              at: entry.message.createdAt,
              attachments: entry.message.attachments?.length ?? 0,
            })),
          },
        ];
      }),
  );
}
