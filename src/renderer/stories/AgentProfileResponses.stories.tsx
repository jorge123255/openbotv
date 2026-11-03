import type { ClientAgentSummary, UpdateAgentInput } from "@openbot/contracts/ipc";
import { onCleanup, snapshot } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AppAccessGate } from "../src/AppView";
import { AppProviders } from "../src/app-providers";
import { useAgents } from "../src/features/agents/agents-context";
import { updateRemoteAgent } from "../src/features/agents/remote-agent-admin";
import { useServerSelection } from "../src/features/servers/server-selection";
import { useServers } from "../src/features/servers/servers-context";
import { LEFT_PANEL_COLLAPSED_STORAGE_KEY } from "../src/layout-constants";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { OpenBotPlayground } from "../src/preview/OpenBotPlayground";
import type { AgentProfileRaceFixture, AgentProfileReplyRemoval } from "./agent-profile-race-fixture";
import { STORY_AGENT_SUMMARIES } from "./fixtures";

const meta = { title: "App profile responses", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const disposedHooks = new WeakSet<AgentProfileRaceFixture>();

function ResponseOrderingStory() {
  const originalHook = window.__agentProfileRace;
  const ownedHooks = new Set<AgentProfileRaceFixture>();
  const previousLayout = localStorage.getItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY);
  localStorage.setItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY, "false");
  const nextMode: Partial<Record<"update" | "avatar", "hold" | "reject" | "hold-error">> = {};
  const held = new Map<number, { resolve: () => void; dispose: () => void }>();
  const jobs: ReturnType<AgentProfileRaceFixture["jobs"]> = [];
  const receipts = { updates: 0, avatars: 0, removals: 0, events: 0 };
  let responseId = 0;
  let mountId = 0;
  let nextReplyPatch: { fields: Partial<ClientAgentSummary>; remove: readonly AgentProfileReplyRemoval[] } | undefined;
  let eventsEnabled = true;
  let stopEvents: (() => void) | undefined;
  onCleanup(() => {
    stopEvents?.();
    for (const item of held.values()) item.dispose();
    held.clear();
    if (!window.__agentProfileRace || ownedHooks.has(window.__agentProfileRace)) {
      if (originalHook && !disposedHooks.has(originalHook)) window.__agentProfileRace = originalHook;
      else Reflect.deleteProperty(window, "__agentProfileRace");
    }
    if (previousLayout === null) localStorage.removeItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY);
    else localStorage.setItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY, previousLayout);
  });
  function start(operation: () => Promise<void>): number {
    const job: ReturnType<AgentProfileRaceFixture["jobs"]>[number] = { id: jobs.length + 1, state: "pending" };
    jobs.push(job);
    void operation().then(
      () => {
        job.state = "fulfilled";
      },
      () => {
        job.state = "rejected";
      },
    );
    return job.id;
  }
  async function intercept(
    kind: "update" | "avatar",
    operation: () => Promise<ClientAgentSummary>,
  ): Promise<ClientAgentSummary> {
    const mode = nextMode[kind];
    const replyPatch = nextReplyPatch;
    nextReplyPatch = undefined;
    delete nextMode[kind];
    // A rejected request never writes or emits a host event.
    if (mode === "reject") throw new Error("Synthetic current profile write failure");
    if (mode === "hold-error")
      return new Promise((_, reject) => {
        const id = ++responseId;
        const fail = () => reject(new Error("Synthetic held profile write failure"));
        held.set(id, { resolve: fail, dispose: fail });
      });
    // Inject valid server-derived contract fields without running a provider or changing a host.
    const saved = { ...(await operation()), ...replyPatch?.fields };
    for (const field of replyPatch?.remove ?? []) delete saved[field];
    if (mode !== "hold") return saved;
    // The host already completed. Delivering this detached snapshot must not run another write/event.
    const completed = structuredClone(saved);
    return new Promise((resolve, reject) => {
      const id = ++responseId;
      held.set(id, {
        resolve: () => resolve(completed),
        dispose: () => reject(new Error("Disposed synthetic profile reply")),
      });
    });
  }
  function Probe() {
    const agents = useAgents();
    const servers = useServers();
    const selection = useServerSelection();
    const instance = { id: ++mountId, serverId: servers.activeServerId() };
    const api: AgentProfileRaceFixture = {
      read: () => structuredClone(snapshot(agents.agentList())),
      patchNextReply: (patch, remove = []) => {
        nextReplyPatch = { fields: structuredClone(patch), remove: [...remove] };
      },
      mount: () => ({ ...instance, settled: agents.agentListSettled() }),
      arm: (kind, mode) => {
        nextMode[kind] = mode;
      },
      held: () => [...held.keys()],
      release: (id) => {
        const item = held.get(id);
        if (!item) throw new Error("Synthetic held reply not found");
        held.delete(id);
        item.resolve();
      },
      jobs: () => structuredClone(jobs),
      startUpdate: (id, updates, report = true) => start(() => agents.updateAgent(id, updates, () => report)),
      startAvatar: (id, image, report = true) => start(() => agents.setAgentAvatar(id, image, () => report)),
      select: agents.setActiveAgentId,
      serverId: servers.activeServerId,
      switchServer: async (id) => {
        const target = id === "other" ? servers.servers().find((server) => server.kind === "remote")?.id : id;
        if (!target) throw new Error("Synthetic remote server not found");
        return selection.selectServer(target, false, false);
      },
      hideUndo: (id) => {
        agents.hideAgent(id)?.();
      },
      remove: async (id) => {
        const stored = await window.openbot.agent.listAgents("local");
        agents.applyStoredAgents(stored.filter((agent) => agent.id !== id));
      },
      errors: () => Object.values(agents.uiErrors()).reduce((count, errors) => count + errors.length, 0),
      setEventsEnabled: (enabled) => {
        eventsEnabled = enabled;
      },
      reload: async () => agents.applyStoredAgents(await window.openbot.agent.listAgents("local")),
      remoteRouting: async (input) => {
        const calls: string[] = [];
        const planCards: { agentId: string; enabled: boolean }[] = [];
        let rejected = false;
        let forwarded: UpdateAgentInput | null = null;
        try {
          await updateRemoteAgent(
            {
              update: async () => {
                calls.push("admin");
              },
              updateHostSettings: async () => {
                calls.push("host");
              },
              updateBackupModels: async () => {
                calls.push("backup");
              },
              updateTaskLimit: async () => {
                calls.push("task-limit");
              },
              updatePlanCard: async (agentId, enabled) => {
                calls.push("plan-card");
                planCards.push({ agentId, enabled });
              },
            },
            input,
            async (profile) => {
              calls.push("profile");
              forwarded = structuredClone(profile);
            },
          );
        } catch {
          rejected = true;
        }
        return { calls, planCards, rejected, forwarded };
      },
      receipts: () => ({ ...receipts }),
    };
    ownedHooks.add(api);
    window.__agentProfileRace = api;
    onCleanup(() => {
      disposedHooks.add(api);
      if (window.__agentProfileRace === api) Reflect.deleteProperty(window, "__agentProfileRace");
    });
    return <output aria-label="Synthetic profile response fixture">ready</output>;
  }
  return (
    <OpenBotPlayground
      options={{
        agents: STORY_AGENT_SUMMARIES.map((agent, index) => ({
          ...agent,
          ...(index === 0
            ? {
                avatarCharacter: "wisp",
                avatarUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              }
            : {}),
        })),
      }}
      dependencies={{
        createMock: (options) => {
          const mock = createMockOpenBot(options);
          const onEvent = mock.api.agent.onEvent;
          stopEvents = onEvent((event) => {
            if (event.type === "agents-changed") receipts.events += 1;
          });
          // Exercise response-only adapters too. The synthetic host still stores/emits every write.
          mock.api.agent.onEvent = (listener) =>
            onEvent((event) => {
              if (eventsEnabled || event.type !== "agents-changed") listener(event);
            });
          const update = mock.api.agent.updateAgent;
          const avatar = mock.api.agent.setAvatar;
          mock.api.agent.updateAgent = (input) =>
            intercept("update", async () => {
              const saved = await update(input);
              receipts.updates += 1;
              return saved;
            });
          mock.api.agent.setAvatar = (input) =>
            intercept("avatar", async () => {
              const saved = await avatar(input);
              if (input.image) receipts.avatars += 1;
              else receipts.removals += 1;
              return saved;
            });
          return mock;
        },
        renderApp: () => (
          <AppProviders>
            <AppAccessGate />
            <Probe />
          </AppProviders>
        ),
      }}
    />
  );
}
export const Ordering: Story = { render: () => <ResponseOrderingStory /> };
