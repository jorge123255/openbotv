import { computeAgentAvatarMoods } from "@openbot/ui/features/agents/agent-avatar-mood";
import { createMemo } from "solid-js";
import { useTurns } from "../../turns";
import { useAgentTasks } from "../agent-tasks/agent-tasks-context";
import { useConversation } from "../conversation/conversation-context";
import { attentionByAgent } from "./agent-runtime-snapshot";
import { useAgents } from "./agents-context";

/** The same runtime face for the roster, chat title and companion above the selected chat. */
export function useAgentAvatarMoods() {
  const { agentList } = useAgents();
  const { activeTurns, queues, failedTurns, pendingPrompts, pendingApprovals } = useTurns();
  const { recentReplies } = useConversation();
  const tasks = useAgentTasks();
  return createMemo(() => {
    const agents = agentList();
    const workingTurns = { ...activeTurns() };
    for (const agent of agents) {
      const running = tasks.snapshot(agent.id)?.tasks.find((task) => task.state === "running");
      if (running && !workingTurns[agent.id]) workingTurns[agent.id] = running.activeTurnId ?? running.id;
    }
    return computeAgentAvatarMoods({
      agentIds: agents.map((agent) => agent.id),
      activeTurns: workingTurns,
      queues: queues(),
      failedTurns: failedTurns(),
      pendingPrompts: attentionByAgent(pendingPrompts(), agents),
      pendingApprovals: pendingApprovals(),
      recentReplies: recentReplies(),
    });
  });
}
