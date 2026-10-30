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
  onCreate: (input: { name: string; description: string }) => void;
}

/** The Grok Bot account on this computer. It does not call `window.openbot`. */
export function GrokBotAccountPanel(props: GrokBotAccountPanelProps) {
  const { t } = useText();
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
          <Item class="settings-modal-row">
            <ItemActions>
              <Button type="button" disabled={props.busy} onClick={() => props.onSignOut()}>
                {t("server.settings.grokBotSignOut")}
              </Button>
              <Button type="button" disabled={props.busy} onClick={() => props.onRefresh()}>
                {t("server.settings.grokBotRefresh")}
              </Button>
            </ItemActions>
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
