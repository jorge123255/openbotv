import type { AgentEvent, Routine, RoutineRun } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import type { ServerView } from "@openbot/ui/features/servers/ServerMenu";
import { createStore, onCleanup, onSettled } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { App } from "../src/App";
import { LEFT_PANEL_COLLAPSED_STORAGE_KEY, SERVER_VIEW_STORAGE_KEY } from "../src/layout-constants";
import { createMockOpenBot, type MockOpenBotOptions } from "../src/preview/mock-openbot";
import { OpenBotPlayground } from "../src/preview/OpenBotPlayground";
import { STORY_AGENT_STATUS, STORY_AGENT_SUMMARIES, STORY_APP_INFO, STORY_SERVERS } from "./fixtures";

const [storyLocalServer, storyRemoteServer] = STORY_SERVERS;
if (!storyLocalServer || !storyRemoteServer) throw new Error("Story server fixtures need a local and a remote server.");

const meta = {
  title: "App",
  component: App,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Sets one stored layout value for the story, and puts the old value back when the story ends. */
function useStoredLayoutValue(key: string, value: string): void {
  const previous = window.localStorage.getItem(key);
  window.localStorage.setItem(key, value);
  onCleanup(() => {
    if (previous === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, previous);
  });
}

function SidebarStatePlayground(props: { compact: boolean; serverView?: ServerView; options?: MockOpenBotOptions }) {
  useStoredLayoutValue(LEFT_PANEL_COLLAPSED_STORAGE_KEY, props.compact ? "true" : "false");
  if (props.serverView) useStoredLayoutValue(SERVER_VIEW_STORAGE_KEY, props.serverView);
  return <OpenBotPlayground options={props.options} />;
}

export const Playground: Story = {
  render: () => <OpenBotPlayground />,
};

export const ExpandedSidebar: Story = {
  render: () => <SidebarStatePlayground compact={false} />,
};

/** Current activity and saved identities in the real app shell, with one sleeping agent. */
export const RosterWorkspace: Story = {
  render: () => (
    <SidebarStatePlayground
      compact={false}
      options={{
        agents: STORY_AGENT_SUMMARIES.map((agent, index) => ({
          ...agent,
          updatedAt: index < 2 ? new Date(Date.now() - index * 60_000).toISOString() : agent.updatedAt,
        })),
      }}
    />
  ),
};

/** The optional character style in the real shell, with original IDs, seeds and hue retained. */
export const CompanionWorkspace: Story = {
  render: () => (
    <SidebarStatePlayground
      compact={false}
      options={{
        agents: STORY_AGENT_SUMMARIES.map((agent, index) => ({
          ...agent,
          avatarCharacter: index === 0 ? "robot" : index === 1 ? "orb" : "shape",
          updatedAt: index < 2 ? new Date(Date.now() - index * 60_000).toISOString() : agent.updatedAt,
        })),
      }}
    />
  ),
};

/** Optional soft characters in the real shell; only synthetic fixture avatars change. */
export const BotAiWorkspace: Story = {
  render: () => (
    <SidebarStatePlayground
      compact={false}
      options={{
        agents: STORY_AGENT_SUMMARIES.map((agent, index) => ({
          ...agent,
          avatarCharacter: index === 0 ? "pebble" : index === 1 ? "wisp" : "sprout",
          updatedAt: index < 2 ? new Date(Date.now() - index * 60_000).toISOString() : agent.updatedAt,
        })),
      }}
    />
  ),
};

/** A busy calendar in the real workspace, with synthetic records only. */
export const WholeAppWorkspace: Story = {
  render: () => {
    const at = new Date().toISOString();
    const routines: Routine[] = Array.from({ length: 28 }, (_, index) => ({
      id: `whole-app-routine-${index}`,
      agentId: "chief",
      name: `Offline review routine ${index + 1}`,
      instruction: "Synthetic fixture. Do not contact a provider.",
      active: true,
      timezone: "UTC",
      trigger: {
        id: `whole-app-trigger-${index}`,
        routineId: `whole-app-routine-${index}`,
        schedule: { kind: "daily", time: "12:00" },
        nextRunAt: at,
        createdAt: at,
        updatedAt: at,
      },
      createdAt: at,
      updatedAt: at,
    }));
    const routineRuns: Record<string, RoutineRun[]> = Object.fromEntries(
      routines.map((routine) => {
        const run: RoutineRun = {
          id: `${routine.id}-completed`,
          routineId: routine.id,
          agentId: routine.agentId,
          triggerId: routine.trigger.id,
          kind: "scheduled",
          scheduledFor: at,
          routineName: routine.name,
          instruction: routine.instruction,
          status: "succeeded",
          error: null,
          deliveryId: null,
          createdAt: at,
          updatedAt: at,
        };
        return [routine.id, [run]];
      }),
    );
    return (
      <SidebarStatePlayground
        compact={false}
        options={{
          agents: STORY_AGENT_SUMMARIES.map((agent, index) => ({
            ...agent,
            avatarCharacter: index === 0 ? "pebble" : index === 1 ? "wisp" : "sprout",
            updatedAt: index < 2 ? new Date(Date.now() - index * 60_000).toISOString() : agent.updatedAt,
          })),
          routines: { chief: routines },
          routineRuns,
        }}
      />
    );
  },
};

/** A failed host save must not remove the existing uploaded image. */
export const CharacterSaveFailure: Story = {
  render: () => {
    useStoredLayoutValue(LEFT_PANEL_COLLAPSED_STORAGE_KEY, "false");
    return (
      <OpenBotPlayground
        options={{
          agents: STORY_AGENT_SUMMARIES.map((agent, index) => ({
            ...agent,
            avatarUrl:
              index === 0
                ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                : agent.avatarUrl,
          })),
        }}
        dependencies={{
          createMock: (options) => {
            const mock = createMockOpenBot(options);
            const update = mock.api.agent.updateAgent;
            mock.api.agent.updateAgent = async (...args) => {
              if (args[0].avatarCharacter !== undefined) throw new Error("Synthetic character save failure");
              return update(...args);
            };
            return mock;
          },
          renderApp: () => <App />,
        }}
      />
    );
  },
};

/** Controlled response order around the real App settings panel. No real host starts. */
function AvatarResponseStory(props: { outcome: "reject" | "succeed"; image?: boolean; completed?: boolean }) {
  useStoredLayoutValue(LEFT_PANEL_COLLAPSED_STORAGE_KEY, "false");
  const [response, setResponse] = createStore({
    phase: "idle",
    older: "idle",
    uploads: 0,
    removals: 0,
  });
  let finishOlder: (() => void) | undefined;
  let disposeOlder: (() => void) | undefined;
  let captured = false;
  onSettled(() => () => disposeOlder?.());
  return (
    <>
      <OpenBotPlayground
        options={{
          agents: STORY_AGENT_SUMMARIES.map((agent, index) => ({
            ...agent,
            avatarCharacter: index === 0 ? "wisp" : agent.avatarCharacter,
            avatarUrl:
              index === 0 && props.image
                ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                : agent.avatarUrl,
          })),
        }}
        dependencies={{
          createMock: (options) => {
            const mock = createMockOpenBot(options);
            const setAvatar = mock.api.agent.setAvatar;
            mock.api.agent.setAvatar = async (input) => {
              const saved = await setAvatar(input);
              setResponse((state) => {
                if (input.image) state.uploads += 1;
                else state.removals += 1;
              });
              return saved;
            };
            const update = mock.api.agent.updateAgent;
            mock.api.agent.updateAgent = async (...args) => {
              if (!captured && args[0].avatarCharacter === "pebble") {
                captured = true;
                // In this mode the host write/event finish first; only immutable response delivery waits.
                const completed = props.completed ? structuredClone(await update(...args)) : undefined;
                setResponse((state) => {
                  state.phase = "pending";
                  state.older = completed ? "completed" : "pending";
                });
                return new Promise((resolve, reject) => {
                  disposeOlder = () => reject(new Error("Disposed synthetic avatar request"));
                  finishOlder = () => {
                    disposeOlder = undefined;
                    if (props.outcome === "reject") {
                      setResponse((state) => {
                        state.older = "rejected";
                      });
                      reject(new Error("Synthetic older avatar save rejection"));
                    } else if (completed) {
                      setResponse((state) => {
                        state.older = "succeeded";
                      });
                      resolve(completed);
                    } else {
                      // Delay the mock invocation, not a pre-upload response snapshot.
                      void update(...args).then(
                        (saved) => {
                          setResponse((state) => {
                            state.older = "succeeded";
                          });
                          resolve(saved);
                        },
                        (error) => {
                          setResponse((state) => {
                            state.older = "rejected";
                          });
                          reject(error);
                        },
                      );
                    }
                  };
                });
              }
              return update(...args);
            };
            return mock;
          },
          renderApp: () => <App />,
        }}
      />
      <div style={{ position: "fixed", bottom: "8px", left: "8px", "z-index": 10000 }}>
        <Button
          disabled={response.phase !== "pending"}
          onClick={() => {
            finishOlder?.();
            finishOlder = undefined;
            setResponse((state) => {
              state.phase = "released";
            });
          }}
        >
          {props.outcome === "reject" ? "Reject older avatar save" : "Complete older avatar save"}
        </Button>
        <output aria-label="Avatar response fixture">{response.phase}</output>
        <output aria-label="Older avatar response fixture">{response.older}</output>
        <output aria-label="Avatar upload completions">{response.uploads}</output>
        <output aria-label="Avatar removal completions">{response.removals}</output>
      </div>
    </>
  );
}

export const AvatarSaveRace: Story = { render: () => <AvatarResponseStory outcome="reject" /> };
export const AvatarUploadRace: Story = { render: () => <AvatarResponseStory outcome="succeed" image /> };
export const AvatarCompletedResponseRace: Story = {
  render: () => <AvatarResponseStory outcome="succeed" image completed />,
};

/** Valid old seed text is not a character selection. */
export const LegacySeedWorkspace: Story = {
  render: () => (
    <SidebarStatePlayground
      compact={false}
      options={{
        agents: STORY_AGENT_SUMMARIES.map((agent, index) => ({
          ...agent,
          avatarSeed:
            index === 0 ? "character:pebble:chief" : index === 1 ? "character:robot:research" : "character:orb:sales",
        })),
      }}
    />
  ),
};

/** Real composer sends and host turn events, with no provider process. */
export const CompanionTurnStates: Story = {
  render: () => {
    useStoredLayoutValue(LEFT_PANEL_COLLAPSED_STORAGE_KEY, "false");
    return (
      <OpenBotPlayground
        options={{
          agents: STORY_AGENT_SUMMARIES.map((agent) => ({
            ...agent,
            avatarCharacter: "robot",
            updatedAt: new Date().toISOString(),
          })),
        }}
        dependencies={{
          createMock: (options) => {
            const mock = createMockOpenBot(options);
            mock.onMessageSent(({ agentId, text, turnId }) => {
              const status = text.startsWith("Fail") ? "failed" : "completed";
              queueMicrotask(() => {
                const snapshot = mock.updateConversationSnapshot(agentId, (snapshot) => {
                  snapshot.activeTurnId = null;
                  snapshot.messages = [
                    ...snapshot.messages,
                    {
                      id: `${turnId}-reply`,
                      turnId,
                      author: "assistant",
                      source: "assistant",
                      text: status === "failed" ? "Offline fixture turn failed." : "Offline fixture reply completed.",
                      createdAt: new Date().toISOString(),
                      status,
                    },
                  ];
                });
                mock.setQueueSnapshot(agentId, []);
                mock.emitAgentEvent({
                  type: "turn-completed",
                  agentId,
                  threadId: snapshot.threadId ?? `thread-${agentId}`,
                  turnId,
                  status,
                });
              });
              return true;
            });
            return mock;
          },
          renderApp: () => <App />,
        }}
      />
    );
  },
};

/** The servers in a rail at the left of the sidebar, instead of the server menu. */
export const ServerRailView: Story = {
  render: () => <SidebarStatePlayground compact={false} serverView="rail" />,
};

export const CompactSidebar: Story = {
  render: () => <SidebarStatePlayground compact={true} />,
};

export const LinuxWindow: Story = {
  render: () => (
    <SidebarStatePlayground compact={false} options={{ appInfo: { ...STORY_APP_INFO, platform: "linux" } }} />
  ),
};

export const EmptyWorkspace: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        agents: [],
        servers: STORY_SERVERS.filter((server) => server.kind === "local"),
        presence: { serverId: "local", updatedAt: "2026-08-24T12:00:00.000Z", members: [] },
        directThreads: [],
        teamMembers: [],
        browserTabs: [],
        remoteDesktopSessions: [],
      }}
    />
  ),
};

export const IncompatibleRemoteHost: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        servers: [
          { ...storyLocalServer, active: false },
          {
            ...storyRemoteServer,
            active: true,
            state: "incompatible",
            compatibility: {
              localAppVersion: "44.0.0",
              hostAppVersion: "42.0.0",
              localProtocol: { minimum: 2, maximum: 2 },
              hostProtocol: { minimum: 1, maximum: 1 },
              negotiatedProtocol: null,
              capabilities: [],
            },
            issue: {
              code: "host_update_required",
              message: "Update OpenBot on the host.",
              retryable: true,
            },
          },
        ],
      }}
    />
  ),
};

export const DifferentRemoteVersions: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        servers: [
          { ...storyLocalServer, active: false },
          {
            ...storyRemoteServer,
            active: true,
            compatibility: {
              localAppVersion: "44.0.0",
              hostAppVersion: "43.0.0",
              localProtocol: { minimum: 1, maximum: 1 },
              hostProtocol: { minimum: 1, maximum: 1 },
              negotiatedProtocol: 1,
              capabilities: [
                "agent-runtime-snapshots",
                "browser-control",
                "conversation-pagination",
                "direct-messages",
                "remote-desktop",
                "sidebar-layout",
              ],
            },
            connectionSequence: 1,
          },
        ],
      }}
    />
  ),
};

/** A joined server has a new OpenBot version. Entering it opens the update dialog each time. */
export const RemoteHostUpdate: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        servers: [
          storyLocalServer,
          {
            ...storyRemoteServer,
            active: false,
            compatibility: {
              localAppVersion: "0.24.0",
              hostAppVersion: "0.23.0",
              localProtocol: { minimum: 1, maximum: 1 },
              hostProtocol: { minimum: 1, maximum: 1 },
              negotiatedProtocol: 1,
              capabilities: ["host-admin-v1", "host-update-v1", "host-release-v1", "sidebar-layout"],
            },
            connectionSequence: 1,
          },
        ],
      }}
    />
  ),
};

export const Onboarding: Story = {
  render: () => (
    <OpenBotPlayground options={{ setupState: { completed: false, preferredProvider: null, preferredModel: null } }} />
  ),
};

export const SignedOut: Story = {
  render: () => <OpenBotPlayground options={{ authState: { status: "signed_out" } }} />,
};

export const AgentStarting: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        agentStatus: {
          ...STORY_AGENT_STATUS,
          phase: "starting",
          message: "Starting local agent CLIs…",
        },
        agents: STORY_AGENT_SUMMARIES.slice(0, 1),
      }}
    />
  ),
};

/**
 * The signed-out provider in the real shell. `sign-in-required` is the only input: the notice, the
 * model picker's label and the suppressed usage chip all read that one field.
 */
export const ProviderSignInRequired: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        agentStatus: {
          ...STORY_AGENT_STATUS,
          auth: { kind: "signed-out" },
          providers: STORY_AGENT_STATUS.providers?.map((provider) =>
            provider.id === "codex"
              ? {
                  ...provider,
                  state: "sign-in-required" as const,
                  email: null,
                  message: "Connect ChatGPT to continue.",
                }
              : provider,
          ),
        },
      }}
    />
  ),
};

/** One agent for each wait: a question, a command approval and a browser takeover. */
const STORY_WAITING_EVENTS: AgentEvent[] = [
  {
    type: "prompt",
    requestId: "story-question",
    agentId: "research",
    threadId: "thread-research",
    turnId: "turn-research-wait",
    questions: [
      {
        id: "region",
        header: "Region",
        question: "Which region should we launch in first?",
        isSecret: false,
        options: [
          { label: "EU", description: "Start with the EU store." },
          { label: "US", description: "Start with the US store." },
        ],
      },
    ],
  },
  {
    type: "approval",
    approval: {
      requestId: "story-approval",
      agentId: "chief",
      threadId: "thread-chief",
      turnId: "turn-chief-wait",
      kind: "command",
      command: "bun run release:publish",
      cwd: null,
      reason: null,
      grantRoot: null,
      permissions: null,
    },
  },
  {
    type: "browser-takeover-requested",
    request: {
      requestId: "story-takeover",
      agentId: "sales",
      threadId: "thread-sales",
      turnId: "turn-sales-wait",
      tabId: "story-tab",
    },
  },
];

/**
 * The "Needs you" group in the real shell. The waits arrive as agent events, so the sidebar reads
 * them through the same bridge as on desktop. Each subscriber gets them again, which is harmless:
 * a wait is kept per agent.
 */
function WaitingForInputPlayground(props: { compact: boolean }) {
  useStoredLayoutValue(LEFT_PANEL_COLLAPSED_STORAGE_KEY, props.compact ? "true" : "false");
  return (
    <OpenBotPlayground
      dependencies={{
        createMock: (options) => {
          const mock = createMockOpenBot(options);
          const subscribe = mock.api.agent.onEvent;
          mock.api.agent.onEvent = (listener) => {
            const unsubscribe = subscribe(listener);
            queueMicrotask(() => {
              for (const event of STORY_WAITING_EVENTS) mock.emitAgentEvent(event);
            });
            return unsubscribe;
          };
          return mock;
        },
        renderApp: () => <App />,
      }}
    />
  );
}

export const AgentsWaitingForInput: Story = {
  render: () => <WaitingForInputPlayground compact={false} />,
};

export const CompactAgentsWaitingForInput: Story = {
  render: () => <WaitingForInputPlayground compact />,
};
