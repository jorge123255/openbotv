/** The switch over the list: bots, the chat list, or routines on the canvas. */

import { Bot, SlidingTabs, UsersRound, Workflow } from "@openbot/ui";
import { useText } from "../../text";
import { useSidebarScope } from "./sidebar-scope";
import type { SidebarView } from "./sidebar-types";

const VIEWS = ["roster", "agents", "routines"] as const satisfies readonly SidebarView[];

function isSidebarView(value: string): value is SidebarView {
  return VIEWS.some((view) => view === value);
}

export function SidebarViewSwitch() {
  const { props } = useSidebarScope();
  const { t } = useText();
  return (
    <div class="sidebar-view-switch">
      <SlidingTabs.Root
        value={props.view ?? "agents"}
        onChange={(value: string) => {
          if (isSidebarView(value)) props.onViewChange?.(value);
        }}
      >
        <SlidingTabs.List class="sidebar-view-tabs" aria-label={t("sidebar.view.label")}>
          <SlidingTabs.Trigger value="roster" class="sidebar-view-tab">
            <UsersRound aria-hidden="true" />
            {t("sidebar.view.roster")}
          </SlidingTabs.Trigger>
          <SlidingTabs.Trigger value="agents" class="sidebar-view-tab">
            <Bot aria-hidden="true" />
            {t("sidebar.view.agents")}
          </SlidingTabs.Trigger>
          <SlidingTabs.Trigger value="routines" class="sidebar-view-tab">
            <Workflow aria-hidden="true" />
            {t("sidebar.view.routines")}
          </SlidingTabs.Trigger>
        </SlidingTabs.List>
      </SlidingTabs.Root>
    </div>
  );
}
