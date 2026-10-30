import { ConversationHeader } from "@openbot/ui/features/conversation/ConversationHeader";
import { SidePanelHeader, SidePanelLauncher } from "@openbot/ui/features/conversation/SidePanel";
import { GrokBotComputerPane } from "@openbot/ui/features/grok-bot/GrokBotComputerPane";
import { GrokBotFilesPane } from "@openbot/ui/features/grok-bot/GrokBotFilesPane";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENT, STORY_AGENT_STATUS, STORY_MODELS, storyRuntimeSettings } from "./fixtures";

const PANES = ["browser", "files", "settings", "voice"] as const;

const agent = { ...STORY_AGENT, name: "Grok Bot", provider: "grok-bot" as const };

function Stage(props: { children: JSX.Element }) {
  return (
    <main
      class="conversation-panel browser-panel-active side-panel-docked"
      style={{
        height: "720px",
        width: "1100px",
        "--browser-panel-width": "420px",
        "--side-panel-width": "420px",
      }}
    >
      <ConversationHeader
        agent={agent}
        onSettingsIntent={fn()}
        onOpenSettings={fn()}
        modelPicker={{
          provider: storyRuntimeSettings(STORY_AGENT).provider,
          value: STORY_AGENT.model,
          reasoningEffort: STORY_AGENT.reasoningEffort,
          modelOptions: STORY_MODELS,
          agentStatus: STORY_AGENT_STATUS,
          onChange: fn(),
          onReasoningEffortChange: fn(),
        }}
        sidePanel={{ open: true, onToggle: fn() }}
      />
      <SidePanelHeader
        panes={[]}
        selected={null}
        available={PANES}
        maximized={false}
        onSelect={fn()}
        onClose={fn()}
        onToggleMaximized={fn()}
        onCollapse={fn()}
      />
      {props.children}
    </main>
  );
}

const meta = {
  title: "Conversation/Grok Bot side panel",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function LauncherPane() {
  const { t } = useText();
  return (
    <aside class="browser-panel side-panel-empty" aria-label={t("conversation.sidePanel.label")}>
      <SidePanelLauncher available={PANES} onOpen={fn()} />
    </aside>
  );
}

/** The pane list for a Grok Bot chat: Browser, Files, Agent settings, and Voice. */
export const Launcher: Story = {
  render: () => (
    <Stage>
      <LauncherPane />
    </Stage>
  ),
};

/** Open Browser asks main to show the sand computer. The screen stays in that window. */
export const Computer: Story = {
  render: () => (
    <Stage>
      <GrokBotComputerPane
        busy={false}
        error={null}
        computer={{
          phase: "running",
          screenAvailable: true,
          windowOpen: true,
          pullPercent: null,
          imageUpdateAvailable: false,
          needsYou: false,
          handoffReason: null,
        }}
        onOpen={fn()}
        onHandBack={fn()}
      />
    </Stage>
  ),
};

/** An agent handed the computer to you. I'm done, continue gives it back. */
export const ComputerNeedsYou: Story = {
  render: () => (
    <Stage>
      <GrokBotComputerPane
        busy={false}
        error={null}
        computer={{
          phase: "running",
          screenAvailable: true,
          windowOpen: true,
          pullPercent: null,
          imageUpdateAvailable: false,
          needsYou: true,
          handoffReason: null,
        }}
        onOpen={fn()}
        onHandBack={fn()}
      />
    </Stage>
  ),
};

/** Grok Bot has no file list in this port. The files stay on the computer. */
export const Files: Story = {
  render: () => (
    <Stage>
      <GrokBotFilesPane />
    </Stage>
  ),
};
