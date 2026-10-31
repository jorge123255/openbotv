import { isUpdateActivePhase } from "@openbot/contracts/ipc";
import { AGENT_TASKS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-tasks-v1";
import { NativeCliUsageDialog } from "@openbot/ui/features/account/NativeCliUsageDialog";
import { nativeCliUsageRows } from "@openbot/ui/features/account/native-cli-usage-view";
import { type SidebarView, sidebarRailPage } from "@openbot/ui/features/sidebar/sidebar-types";
import { PageRail, type PageRailPage } from "@openbot/ui/features/window/PageRail";
import { useText } from "@openbot/ui/text";
import { createSignal, Show } from "solid-js";
import { appPort } from "../../app-port";
import { useLayout } from "../../layout";
import { usePlatform } from "../../platform";
import { useChannels } from "../channels/channels-context";
import { useCustomAgents } from "../custom-agents/custom-agents-context";
import { serverSupportsCapability } from "../servers/server-capabilities";
import { useServers } from "../servers/servers-context";
import { useSettings } from "../settings/settings-context";
import { useUpdates } from "../updates/updates-context";
import { useWhatsNew } from "../updates/whats-new-context";
import { useNativeCliUsage } from "../usage/native-cli-usage-context";
import { usePlanLimitRows } from "../usage/plan-limit-rows";
import { RailHelpMenu } from "./RailHelpMenu";
import { useWindowPage } from "./window-page-context";

/**
 * The page rail of the desktop window. Agents, Routines, Workflows, Schedule, Usage, Marketplace and
 * Settings change the page in the card.
 */
export function WorkspacePageRail(props: { hidden: boolean }) {
  const text = useText();
  const windowPage = useWindowPage();
  const { openAppSettings, setSkillsMarketplaceOpen } = useSettings();
  const updates = useUpdates();
  const layout = useLayout();
  const channels = useChannels();
  const whatsNew = useWhatsNew();
  const { activeServer } = useServers();
  const platform = usePlatform();
  /** macOS draws the window buttons in the top row of the rail. Windows and Linux show the logo there. */
  const logo = () => {
    const info = platform.appInfo();
    return info && info.platform !== "darwin" ? { variant: info.variant } : undefined;
  };
  /** Agents and Routines show the same page; they set the list of the sidebar. */
  function showSidebarView(view: SidebarView) {
    windowPage.showAgents();
    // An open channel would stay in the middle with no row in the list.
    if (view !== "agents") channels.close();
    layout.setSidebarView(view);
  }
  const usageRows = usePlanLimitRows();
  const { customAgentUsage } = useCustomAgents();
  /** The custom agents run on this computer, so a joined server does not show their usage. */
  const localAgentUsage = () => (activeServer()?.kind === "local" ? customAgentUsage() : []);
  const nativeUsage = useNativeCliUsage();
  const [nativeOpen, setNativeOpen] = createSignal<"kimi" | "devin" | null>(null);
  const nativeRows = () => nativeCliUsageRows(nativeUsage.state.reading, nativeUsage.state.now, text);
  const nativeRow = () =>
    activeServer()?.kind === "local" ? nativeRows().find((row) => row.id === nativeOpen()) : undefined;
  /** The compact sidebar has no footer, so the update island does not show. The Settings button then marks the update. */
  const updateNotice = () => {
    const phase = updates.status().phase;
    if (!layout.leftPanelCompact() || !isUpdateActivePhase(phase)) return undefined;
    return text.t(phase === "ready" || phase === "installing" ? "account.update.ready" : "account.update.available");
  };
  // An older joined server has no task routes.
  const tasksAvailable = () => {
    const server = activeServer();
    return !server || server.kind === "local" || serverSupportsCapability(server, AGENT_TASKS_CAPABILITY);
  };
  const current = (): PageRailPage | null => {
    const page = windowPage.page();
    if (page === "agents") return sidebarRailPage(layout.sidebarView());
    return page === "server-settings" ? null : page;
  };
  return (
    <>
      <PageRail
        hidden={props.hidden}
        current={current()}
        pinned={layout.railPinned()}
        onPinChange={layout.setRailPinned}
        usageRows={usageRows()}
        openUrl={(url) => void appPort().openUrl(url)}
        customAgentUsage={localAgentUsage()}
        nativeUsage={
          activeServer()?.kind === "local"
            ? { rows: nativeRows(), now: nativeUsage.state.now, onOpen: setNativeOpen }
            : undefined
        }
        onAgents={() => showSidebarView("agents")}
        onRoutines={() => showSidebarView("routines")}
        // A joined server without workflows shows its notice on the page.
        onWorkflows={() => windowPage.openWorkflows(null)}
        onSchedule={windowPage.openSchedule}
        onTasks={tasksAvailable() ? windowPage.openTasks : undefined}
        onUsage={windowPage.openUsage}
        onMarketplace={() => setSkillsMarketplaceOpen(true)}
        onSettings={(button) => (updateNotice() ? openAppSettings(button, "updates") : windowPage.openSettings(button))}
        settingsNotice={updateNotice()}
        logo={logo()}
        help={
          <RailHelpMenu
            version={whatsNew.state.version}
            onOpenWhatsNew={whatsNew.reopen}
            onOpenLink={(destination) => void appPort().openExternal(destination)}
          />
        }
      />
      <Show when={nativeRow()}>
        {(row) => (
          <NativeCliUsageDialog
            row={row()}
            snapshot={nativeUsage.state.reading}
            now={nativeUsage.state.now}
            busy={nativeUsage.state.busy}
            error={nativeUsage.state.error}
            onConnect={(input) => void nativeUsage.connect(input)}
            onRead={() => void nativeUsage.read()}
            onDisconnect={() => void nativeUsage.disconnect()}
            onClose={() => setNativeOpen(null)}
          />
        )}
      </Show>
    </>
  );
}
