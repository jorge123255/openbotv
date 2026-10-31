import { BookOpen, Button, Heading, Plug, ShieldCheck, SlidingTabs, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { AppRow } from "./MarketplaceCards";
import type { MarketplaceApp } from "./marketplace-model";
import type { MarketplaceScope } from "./marketplace-view";

const MODES = ["discover", "manage", "create"] as const;
const MODE_LABEL = {
  discover: "marketplace.plugins.discover",
  manage: "marketplace.plugins.manage",
  create: "marketplace.plugins.create",
} as const;

/** Routes every action through the existing marketplace, skill and MCP owners. */
export function MarketplacePlugins(props: {
  scope: MarketplaceScope;
  apps: readonly MarketplaceApp[];
  discover: JSX.Element;
}) {
  const { t } = useText();
  const nav = () => props.scope.nav;
  const mode = () => nav().state.pluginMode;
  // Include a connecting app so its pending operation is still visible in Manage.
  const managed = () => props.apps.filter((app) => app.kind === "custom" || app.status !== "idle");
  const createSkill = () => (props.scope.model.agents().length > 0 ? props.scope.model.createSkill : undefined);
  return (
    <div class="marketplace-plugins">
      <SlidingTabs.Root
        value={mode()}
        onChange={(value: string) => {
          const next = MODES.find((entry) => entry === value);
          if (next)
            nav().set((draft) => {
              draft.pluginMode = next;
            });
        }}
      >
        <SlidingTabs.List aria-label={t("marketplace.plugins.views")}>
          <For each={MODES}>
            {(entry) => <SlidingTabs.Trigger value={entry}>{t(MODE_LABEL[entry])}</SlidingTabs.Trigger>}
          </For>
        </SlidingTabs.List>
        <SlidingTabs.ContentSlot>
          <SlidingTabs.Content value="discover">
            <div class="marketplace-plugin-note">
              <ShieldCheck aria-hidden="true" />
              <Text as="p" variant="body-sm" tone="muted">
                {t("marketplace.plugins.permissions")}
              </Text>
            </div>
            {props.discover}
          </SlidingTabs.Content>
          <SlidingTabs.Content value="manage">
            <div class="marketplace-plugin-note">
              <Text as="p" variant="body-sm" tone="muted">
                {t("marketplace.plugins.manageHint")}
              </Text>
            </div>
            <Show
              when={managed().length > 0}
              fallback={
                <div class="marketplace-empty">
                  <Text as="p" variant="body-sm" tone="muted">
                    {t("marketplace.plugins.empty")}
                  </Text>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      nav().set((draft) => {
                        draft.pluginMode = "discover";
                        draft.query = "";
                      })
                    }
                  >
                    {t("marketplace.plugins.discover")}
                  </Button>
                </div>
              }
            >
              <p class="marketplace-app-group-title" role="status">
                {t("marketplace.plugins.managedCount", { count: managed().length })}
              </p>
              <ul class="marketplace-app-list">
                <For each={managed()} keyed={(app) => app.id}>
                  {(app) => <AppRow scope={props.scope} app={app()} />}
                </For>
              </ul>
            </Show>
          </SlidingTabs.Content>
          <SlidingTabs.Content value="create">
            <div class="marketplace-plugin-note">
              <Text as="p" variant="body-sm" tone="muted">
                {t("marketplace.plugins.createHint")}
              </Text>
            </div>
            <div class="marketplace-plugin-create">
              <section class="marketplace-plugin-create-option">
                <Plug aria-hidden="true" />
                <Heading as="h4" size="sm">
                  {t("marketplace.plugins.mcpTitle")}
                </Heading>
                <Text as="p" variant="body-sm" tone="muted">
                  {t("marketplace.plugins.mcpHint")}
                </Text>
                <Show
                  when={props.scope.model.addServer}
                  fallback={
                    <Text as="p" variant="body-sm" tone="muted">
                      {t("marketplace.plugins.hostOnly")}
                    </Text>
                  }
                >
                  {(add) => (
                    <Button variant="outline" size="sm" onClick={() => add()()}>
                      {t("marketplace.app.addCustom")}
                    </Button>
                  )}
                </Show>
              </section>
              <section class="marketplace-plugin-create-option">
                <BookOpen aria-hidden="true" />
                <Heading as="h4" size="sm">
                  {t("marketplace.plugins.skillTitle")}
                </Heading>
                <Text as="p" variant="body-sm" tone="muted">
                  {t("marketplace.plugins.skillHint")}
                </Text>
                <Show
                  when={createSkill()}
                  fallback={
                    <Button variant="outline" size="sm" onClick={() => nav().show("skills")}>
                      {t("marketplace.tab.skills")}
                    </Button>
                  }
                >
                  {(create) => (
                    <Button variant="outline" size="sm" onClick={() => create()(props.scope.model.activeAgentId())}>
                      {t("skill.toolbar.create")}
                    </Button>
                  )}
                </Show>
              </section>
            </div>
            <Text as="p" variant="body-sm" tone="muted">
              {t("marketplace.plugins.appearanceHint")}
            </Text>
          </SlidingTabs.Content>
        </SlidingTabs.ContentSlot>
      </SlidingTabs.Root>
    </div>
  );
}
