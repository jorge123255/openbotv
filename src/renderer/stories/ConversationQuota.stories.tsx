import type { AgentStatus, CustomProviderSummary, OllamaQuotaSnapshot } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import { createSignal, flush, onSettled } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createConversationController } from "../src/features/conversation/Conversation";
import { ConversationView } from "../src/features/conversation/ConversationView";
import { ConversationControllerProvider } from "../src/features/conversation/conversation-controller-context";
import { CONVERSATION_STORY_ARGS, StoryAppProviders } from "./conversation-story-support";
import { requireFixture, STORY_AGENT, STORY_AGENT_STATUS, STORY_MODELS } from "./fixtures";
import { createMockOpenBot } from "./mock-openbot";

const endpoint: CustomProviderSummary = {
  id: "mock-cloud",
  name: "Personal cloud",
  baseUrl: "https://ollama.com/v1",
  hasApiKey: true,
  headerNames: [],
  harness: "opencode",
  models: [{ id: "mock-model", name: "Mock cloud model" }],
};
const alternative = requireFixture(
  STORY_MODELS.find((model) => model.provider === "claude"),
  "Claude model",
);
function Fixture(props: { changeAccountOnCheck?: boolean }) {
  const previous = window.openbot;
  const mock = createMockOpenBot();
  const controller = createConversationController({ onTypingChange: () => undefined });
  const [agent, setAgent] = createSignal<AgentProfile>({
    ...STORY_AGENT,
    provider: "opencode" as const,
    model: "mock-cloud/mock-model",
    backupModels: { automatic: false, order: [{ provider: "claude" as const, model: alternative.id }] },
  });
  const [events, setEvents] = createSignal({ changes: 0, sends: 0, stops: 0 });
  const [supported, setSupported] = createSignal(true);
  const [listeners] = createSignal(new Set<() => void>());
  const [status, setStatus] = createSignal<AgentStatus>({
    ...STORY_AGENT_STATUS,
    providers: [
      ...(STORY_AGENT_STATUS.providers ?? []),
      { id: "opencode" as const, state: "available" as const, version: "mock", message: null, email: null },
    ],
  });
  let reads = 0;
  mock.api.ollamaQuota = {
    read: async () => {
      reads++;
      if (props.changeAccountOnCheck && reads === 2) {
        setStatus((old) => ({
          ...old,
          providers: old.providers?.map((provider) =>
            provider.id === "claude" ? { ...provider, email: "changed-account@example.com" } : provider,
          ),
        }));
        flush();
      }
      return supported()
        ? ({
            connectionId: endpoint.id,
            connectionName: endpoint.name,
            poolId: "mock-pool",
            state: "fresh",
            checkedAt: Date.now(),
            retryAt: Date.now() + 60_000,
            purchasedBalanceUsd: 25,
            windows: [
              {
                id: "included",
                usedPercent: 95,
                startsAt: Date.now() - 86_400_000,
                resetsAt: Date.now() + 86_400_000,
                balanceUsd: 5,
                allowanceUsd: 100,
                warningId: "mock-warning",
              },
            ],
          } satisfies OllamaQuotaSnapshot)
        : null;
    },
    dismiss: async () => {
      setSupported(false);
      for (const listener of listeners()) listener();
    },
    onChanged: (listener) => {
      listeners().add(listener);
      return () => listeners().delete(listener);
    },
  };
  window.openbot = mock.api;
  onSettled(() => () => {
    mock.dispose();
    window.openbot = previous;
  });

  return (
    <div class="conversation-story-frame">
      <StoryAppProviders>
        <ConversationControllerProvider controller={controller}>
          <ConversationView
            {...CONVERSATION_STORY_ARGS}
            agent={agent()}
            agents={[agent()]}
            agentStatus={status()}
            customProviders={[endpoint]}
            modelOptions={[
              ...STORY_MODELS,
              { ...alternative, provider: "opencode", id: "mock-cloud/mock-model", name: "Mock cloud model" },
            ]}
            activeTurnId="mock-running-turn"
            onUpdateAgent={async (_id, updates) => {
              if (!updates.provider || !updates.model || !updates.reasoningEffort)
                throw new Error("Expected runtime change.");
              setEvents((old) => ({ ...old, changes: old.changes + 1 }));
              setAgent((old) => ({
                ...old,
                pendingRuntime: {
                  provider: updates.provider ?? "claude",
                  model: updates.model ?? alternative.id,
                  reasoningEffort: updates.reasoningEffort ?? "medium",
                },
              }));
            }}
            onSendMessage={async () => {
              setEvents((old) => ({ ...old, sends: old.sends + 1 }));
              return { messageId: "mock-sent" };
            }}
            onStop={() => {
              setEvents((old) => ({ ...old, stops: old.stops + 1 }));
            }}
          />
          <output aria-label="Fixture actions">
            Model changes: {events().changes}; messages sent: {events().sends}; stops: {events().stops}
          </output>
        </ConversationControllerProvider>
      </StoryAppProviders>
    </div>
  );
}
const meta = {
  title: "Conversation/Ollama quota integration",
  component: Fixture,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ActiveTurn: Story = {};

export const AccountChangesDuringConfirmation: Story = { args: { changeAccountOnCheck: true } };
