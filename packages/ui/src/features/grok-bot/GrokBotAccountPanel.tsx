import type { GrokBotUsageSummary } from "@openbot/contracts/ipc";
import {
  Button,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
} from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { AccountUsageWindowList } from "../account/AccountUsageDetails";
import { grokBotUsageRow } from "../account/grok-bot-usage-row";

export interface GrokBotAccountAgent {
  id: string;
  name: string;
  title: string;
  description: string;
  hidden: boolean;
  room: boolean;
}

export interface GrokBotAccountPanelProps {
  signedIn: boolean;
  agents: readonly GrokBotAccountAgent[];
  busy: boolean;
  error: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onRefresh: () => void;
  /** Mirrors the listed agents into this computer's roster. Never creates anything in Grok Bot. */
  onImport?: (() => void) | undefined;
  notice?: string | null | undefined;
  onCreate: (input: { name: string; description: string }) => void;
  usage: GrokBotUsageSummary | null;
  onChangeLimit: () => void;
  onTrial: () => void;
}

/** The Grok Bot account on this computer. It does not call `window.openbot`. */
export function GrokBotAccountPanel(props: GrokBotAccountPanelProps) {
  const { t, format } = useText();
  const usageRow = () => {
    const usage = props.usage;
    if (!usage) return null;
    return grokBotUsageRow(usage, {
      name: t("account.usage.grokBot"),
      included: t("account.usage.grokBot.included"),
      onDemand: usage.onDemand
        ? t("account.usage.grokBot.onDemandLabel", {
            used: format.currencyUsd(usage.onDemand.usedUsd),
            limit: format.currencyUsd(usage.onDemand.limitUsd),
          })
        : "",
      formatReset: (date) => format.date(date, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    });
  };
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const visible = () => props.agents.filter((agent) => !agent.hidden);
  const submit = () => {
    const next = name().trim();
    if (next.length === 0) return;
    props.onCreate({ name: next, description: description().trim() });
    setName("");
    setDescription("");
  };

  return (
    <SettingsSection title={t("server.settings.grokBotTitle")} description={t("server.settings.grokBotDescription")}>
      <ItemGroup class="settings-modal-card">
        <Show
          when={props.signedIn}
          fallback={
            <Item class="settings-modal-row">
              <ItemActions>
                <Button type="button" disabled={props.busy} onClick={() => props.onSignIn()}>
                  {t("server.settings.grokBotSignIn")}
                </Button>
              </ItemActions>
            </Item>
          }
        >
          <Show when={props.usage}>
            {(usage) => (
              <Item class="settings-modal-row">
                <ItemContent>
                  <Show when={usageRow()}>
                    {(row) => <AccountUsageWindowList windows={row().windows} now={Date.now()} />}
                  </Show>
                  <Show when={usage().enterprise}>
                    <ItemDescription>{t("account.usage.grokBot.enterprise")}</ItemDescription>
                  </Show>
                  <Show when={usage().changeLimit}>
                    <Button type="button" onClick={() => props.onChangeLimit()}>
                      {t("account.usage.grokBot.changeLimit")}
                    </Button>
                  </Show>
                  <Show when={usage().trialClaim}>
                    <Button type="button" onClick={() => props.onTrial()}>
                      {t("account.usage.grokBot.trial")}
                    </Button>
                  </Show>
                </ItemContent>
              </Item>
            )}
          </Show>
          <Item class="settings-modal-row">
            <ItemActions>
              <Button type="button" disabled={props.busy} onClick={() => props.onSignOut()}>
                {t("server.settings.grokBotSignOut")}
              </Button>
              <Button type="button" disabled={props.busy} onClick={() => props.onRefresh()}>
                {t("server.settings.grokBotRefresh")}
              </Button>
              <Show when={props.onImport}>
                {(onImport) => (
                  <Button type="button" disabled={props.busy} onClick={() => onImport()()}>
                    {t("server.settings.grokBotImport")}
                  </Button>
                )}
              </Show>
            </ItemActions>
            <Show when={props.notice}>{(notice) => <ItemDescription>{notice()}</ItemDescription>}</Show>
          </Item>
          <Show
            when={visible().length > 0}
            fallback={
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemDescription>{t("server.settings.grokBotEmpty")}</ItemDescription>
                </ItemContent>
              </Item>
            }
          >
            <For each={visible()}>
              {(agent) => (
                <Item class="settings-modal-row">
                  <ItemContent>
                    <ItemTitle>
                      {agent.name || agent.title}
                      <Show when={agent.room}> {t("server.settings.grokBotGroup")}</Show>
                    </ItemTitle>
                    <Show when={agent.description.length > 0}>
                      <ItemDescription>{agent.description}</ItemDescription>
                    </Show>
                  </ItemContent>
                </Item>
              )}
            </For>
          </Show>
          <Item class="settings-modal-row">
            <ItemContent>
              <Input
                value={name()}
                placeholder={t("server.settings.grokBotName")}
                onInput={(event) => setName(event.currentTarget.value)}
              />
              <Input
                value={description()}
                placeholder={t("server.settings.grokBotInstructions")}
                onInput={(event) => setDescription(event.currentTarget.value)}
              />
              <ItemDescription>{t("server.settings.grokBotImportHint")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button type="button" disabled={props.busy} onClick={submit}>
                {t("server.settings.grokBotCreate")}
              </Button>
            </ItemActions>
          </Item>
        </Show>
        <Show when={props.error}>
          {(message) => (
            <Item class="settings-modal-row">
              <ItemContent>
                <ItemDescription>{message()}</ItemDescription>
              </ItemContent>
            </Item>
          )}
        </Show>
      </ItemGroup>
    </SettingsSection>
  );
}
