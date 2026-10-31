import { type ChannelMessage, type ChannelTask, channelRoutingConversationEventItemType } from "@openbot/contracts/ipc";
import { ChatActionMarker } from "@openbot/ui/features/conversation/ChatActionMarker";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { channelTaskActivity } from "../src/features/channels/channel-task-activity";
import type { MockChannelSeed } from "../src/preview/mock-channels";
import { requireFixture, STORY_AGENTS } from "./fixtures";
import { PrototypeApp } from "./prototype-support";

const channelId = "assignment-channel";
const task = (id: string, instruction: string, state: ChannelTask["state"]): ChannelTask => ({
  id,
  channelId,
  rootTaskId: id,
  parentTaskId: null,
  ownerAgentId: "chief",
  instruction,
  requestMessageId: `request-${id}`,
  expectedResult: "Report the result here.",
  sourceMessageIds: [`request-${id}`],
  attachmentDraftIds: [],
  dependencies: [],
  resources: [],
  state,
  revision: 1,
  assignmentCount: 1,
  error: null,
});
const tasks = [
  task("queued-task", "Check the release status.", "queued"),
  task("working-task", "Inspect the release output.", "running"),
  task("completed-task", "Review the earlier release.", "completed"),
];
function message(
  id: string,
  taskId: string,
  text: string,
  minute: number,
  routing = false,
  agent = false,
): ChannelMessage {
  return {
    id,
    channelId,
    taskId,
    sequence: minute + 1,
    superseded: false,
    author: {
      kind: routing || agent ? "agent" : "member",
      id: routing || agent ? "chief" : "local",
      name: routing || agent ? "Chief" : "You",
    },
    message: {
      id,
      author: routing ? "system" : agent ? "assistant" : "user",
      text,
      createdAt: `2026-10-31T12:${String(minute).padStart(2, "0")}:00.000Z`,
      status: "completed",
      ...(routing ? { itemType: channelRoutingConversationEventItemType("assigned", "chief") } : {}),
    },
  };
}
const queued = requireFixture(tasks[0], "The queued assignment task");
const seed: MockChannelSeed = {
  channel: {
    id: channelId,
    name: "Assignment checks",
    title: "",
    instructions: "",
    members: [{ agentId: "chief" }, { agentId: "research" }],
    leadAgentId: "chief",
    revision: 1,
    archived: false,
    createdAt: "2026-10-31T12:00:00.000Z",
  },
  tasks,
  messages: tasks.flatMap((task, index) => [
    message(task.requestMessageId, task.id, task.instruction, index * 3),
    message(`assigned-${task.id}`, task.id, "Assigned to Chief.", index * 3 + 1, true),
    ...(task.state === "queued"
      ? []
      : [
          message(
            `update-${task.id}`,
            task.id,
            task.state === "completed" ? "Earlier review is complete." : "Reading the synthetic release output.",
            index * 3 + 2,
            false,
            true,
          ),
        ]),
  ]),
};

declare global {
  interface Window {
    channelActivityFixture: {
      privateReads: number;
      writes: number;
      mutate: (state: ChannelTask["state"], recipient?: string) => Promise<void>;
    };
  }
}

function AssignmentFixture() {
  return (
    <PrototypeApp
      options={{ channels: [seed] }}
      setup={(mock) => {
        const api = mock.api.agent;
        const read = api.readConversationPage;
        const readChannel = api.readChannel;
        let state: ChannelTask["state"] = queued.state;
        let owner = "chief";
        window.channelActivityFixture = {
          privateReads: 0,
          writes: 0,
          mutate: async (next, recipient) => {
            state = next;
            owner = recipient ?? owner;
            const page = await readChannel({ channelId });
            await change({
              type: "save",
              channelId,
              operationId: crypto.randomUUID(),
              draft: page.channel,
              update: true,
            });
          },
        };
        api.readConversationPage = async (...args) => {
          window.channelActivityFixture.privateReads++;
          return read(...args);
        };
        api.readChannel = async (...args) => {
          const page = await readChannel(...args);
          return page.channel.id !== channelId
            ? page
            : {
                ...page,
                tasks: page.tasks.map((task) =>
                  task.id !== queued.id
                    ? task
                    : {
                        ...task,
                        state,
                        ownerAgentId: owner,
                        error:
                          state === "failed" ? "Synthetic provider session unavailable. No work was started." : null,
                      },
                ),
              };
        };
        const change = api.channelCommand;
        api.channelCommand = async (...args) => {
          window.channelActivityFixture.writes++;
          return change(...args);
        };
        const cancel = api.cancelChannelTask;
        api.cancelChannelTask = async (...args) => {
          window.channelActivityFixture.writes++;
          return cancel(...args);
        };
        const recover = api.recoverChannelTask;
        api.recoverChannelTask = async (...args) => {
          window.channelActivityFixture.writes++;
          return recover(...args);
        };
        const send = api.sendMessage;
        api.sendMessage = async (...args) => {
          window.channelActivityFixture.writes++;
          return send(...args);
        };
      }}
    />
  );
}
const meta = {
  title: "Channels/Assignment activity",
  component: AssignmentFixture,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AssignmentFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Assigned: Story = {};

/** Same component, data and global CSS; no transcript behind its opaque modal for Axe to mis-sample. */
export const Contrast: Story = {
  render: () => {
    const views = channelTaskActivity({ ...seed, tasks, olderCursor: null, throughSequence: 10 }, STORY_AGENTS, {
      unassigned: "Unassigned",
      unavailable: "Unavailable agent",
    });
    return (
      <div style={{ padding: "var(--openbot-space-6)", background: "var(--openbot-bg-canvas)" }}>
        <ChatActionMarker
          marker={{
            kind: "channel-routing",
            action: "assigned",
            agentId: "chief",
            timestamp: "2026-10-31T12:04:00.000Z",
            task: requireFixture(views.get("working-task"), "The working assignment task"),
          }}
          agents={STORY_AGENTS}
          onSelectAgent={() => {
            throw new Error("A task view must not select the private chat.");
          }}
        />
      </div>
    );
  },
};
