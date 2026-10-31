import type {
  CancelChannelTaskInput,
  ChannelMessage,
  ChannelTask,
  RecoverChannelTaskInput,
} from "@openbot/contracts/ipc";
import { ChannelStoppedTasks } from "@openbot/ui/features/channels/ChannelStoppedTasks";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { channelTaskAttention } from "../src/features/channels/channel-task-attention";
import type { MockChannelSeed } from "../src/preview/mock-channels";
import { PrototypeApp } from "./prototype-support";

const channelId = "attention-channel";
const task = (id: string, ownerAgentId: string | null, instruction: string): ChannelTask => ({
  id,
  channelId,
  rootTaskId: id,
  parentTaskId: null,
  ownerAgentId,
  instruction,
  requestMessageId: `request-${id}`,
  attachmentDraftIds: [],
  expectedResult: "Confirm the work.",
  sourceMessageIds: [`request-${id}`],
  dependencies: [],
  resources: [],
  state: "paused",
  revision: 2,
  assignmentCount: 1,
  error: "The previous turn has no confirmed result. Check its work before you resume.",
});
const root = task("root-task", "chief", "Check the deployment status.");
const child = {
  ...task("child-task", "research", "Inspect the deployment output."),
  rootTaskId: root.id,
  parentTaskId: root.id,
  error: '{"type":"turn/completed","status":"interrupted","detail":"RESULT_UNCONFIRMED"}',
};
const other = task("other-task", null, "Assign the follow-up review.");
const message = (id: string, taskId: string, text: string, minute: number, agent = false): ChannelMessage => ({
  id,
  channelId,
  taskId,
  sequence: minute + 1,
  superseded: false,
  author: { kind: agent ? "agent" : "member", id: agent ? "chief" : "local", name: agent ? "Chief" : "You" },
  message: {
    id,
    author: agent ? "assistant" : "user",
    text,
    createdAt: `2026-10-30T18:${String(minute).padStart(2, "0")}:00.000Z`,
    status: "completed",
  },
});
const seed: MockChannelSeed = {
  channel: {
    id: channelId,
    name: "Release checks",
    title: "",
    instructions: "",
    members: [{ agentId: "chief" }, { agentId: "research" }],
    leadAgentId: "chief",
    revision: 4,
    archived: false,
    createdAt: "2026-10-30T18:00:00.000Z",
  },
  tasks: [root, child, other],
  messages: [
    message(root.requestMessageId, root.id, root.instruction, 0),
    message("tool-result", root.id, "Created the deployment marker. Check the service before continuing.", 1, true),
    message(child.requestMessageId, child.id, child.instruction, 2),
    message(other.requestMessageId, other.id, other.instruction, 3),
  ],
};

declare global {
  interface Window {
    attentionFixture: {
      actions: (
        | { kind: "cancel"; input: CancelChannelTaskInput }
        | { kind: "recover"; input: RecoverChannelTaskInput }
      )[];
      change: () => Promise<void>;
      failAfterCancel: boolean;
      hold: boolean;
      allowEarlier: boolean;
      release: (() => void) | null;
    };
  }
}

function AttentionFixture(props: { partial?: boolean }) {
  return (
    <PrototypeApp
      options={{ channels: [seed] }}
      setup={(mock) => {
        const agent = mock.api.agent;
        window.attentionFixture = {
          actions: [],
          failAfterCancel: false,
          hold: false,
          allowEarlier: false,
          release: null,
          change: async () => {
            const current = await agent.readChannel({ channelId });
            await agent.channelCommand({
              type: "save",
              channelId,
              operationId: crypto.randomUUID(),
              draft: current.channel,
              update: true,
            });
          },
        };
        const cancel = agent.cancelChannelTask;
        agent.cancelChannelTask = async (input, server) => {
          window.attentionFixture.actions.push({ kind: "cancel", input: structuredClone(input) });
          if (window.attentionFixture.hold)
            await new Promise<void>((resolve) => {
              window.attentionFixture.release = resolve;
            });
          const result = await cancel(input, server);
          if (window.attentionFixture.failAfterCancel) throw new Error("Synthetic response loss after cancellation.");
          return result;
        };
        const recover = agent.recoverChannelTask;
        agent.recoverChannelTask = async (input, server) => {
          window.attentionFixture.actions.push({ kind: "recover", input: structuredClone(input) });
          return recover(input, server);
        };
        if (props.partial) {
          const read = agent.readChannel;
          agent.readChannel = async (input, server) => {
            const page = await read(input, server);
            if (input.channelId !== channelId) return page;
            // Keep the automatic top-of-history read incomplete until the fixture releases it.
            if (input.beforeSequence && !window.attentionFixture.allowEarlier)
              return { ...page, messages: [], olderCursor: 3 };
            return input.beforeSequence
              ? { ...page, messages: page.messages.slice(0, 2), olderCursor: null }
              : { ...page, messages: page.messages.slice(2), olderCursor: 3 };
          };
        }
      }}
    />
  );
}

const meta = {
  title: "Channels/Task attention",
  component: AttentionFixture,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AttentionFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Stopped: Story = {};
export const EarlierActivity: Story = { args: { partial: true } };
export const OlderHost: Story = {
  render: () => (
    <div style={{ padding: "var(--openbot-space-6)" }}>
      <ChannelStoppedTasks
        tasks={channelTaskAttention({ ...seed, tasks: seed.tasks ?? [], olderCursor: null, throughSequence: 4 })}
        members={seed.channel.members}
        name={(id) => id ?? "Unassigned"}
        actionsSupported={false}
        onResume={async () => false}
        onCancel={async () => false}
      />
    </div>
  ),
};
