/**
 * The bots list: every agent, newest first, with quiet agents under Asleep.
 * A press wakes a quiet agent and opens its chat.
 */

import type { AppFormat, AppTextKey, AppTranslate } from "@openbot/i18n";
import { AudioLines, Button, LabelTooltip, LabelTooltipTrigger } from "@openbot/ui";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { AvatarMood } from "../../bloub-avatar";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import {
  partitionRoster,
  ROSTER_FILTERS,
  type RosterEntry,
  type RosterEntrySource,
  type RosterFilter,
  type RosterTime,
  rosterKindKeepsAwake,
  rosterRelativeTime,
} from "./roster-model";
import { playRosterSound, type RosterCue } from "./roster-sound";
import { SidebarEmptyState } from "./SidebarEmptyState";
import { sidebarAgentStateLabel } from "./sidebar-filtering";
import { useSidebarScope } from "./sidebar-scope";
import type { SidebarAgentState } from "./sidebar-types";

const FILTER_LABEL = {
  all: "sidebar.roster.filter.all",
  monitor: "sidebar.roster.filter.monitor",
  worker: "sidebar.roster.filter.worker",
  artist: "sidebar.roster.filter.artist",
  helper: "sidebar.roster.filter.helper",
} as const satisfies Record<RosterFilter, AppTextKey>;

const SOUND_LABEL = {
  monitor: "sidebar.roster.sound.monitor",
  worker: "sidebar.roster.sound.worker",
  artist: "sidebar.roster.sound.artist",
  helper: "sidebar.roster.sound.helper",
  needsYou: "sidebar.roster.sound.needsYou",
  asleep: "sidebar.roster.sound.asleep",
} as const satisfies Record<RosterCue, AppTextKey>;

function rosterCopy(
  agent: AgentProfile,
  state: SidebarAgentState | undefined,
  t: AppTranslate,
  format: AppFormat,
): string {
  const preview = agent.preview.trim();
  if (!state) return preview || t("sidebar.roster.status.empty");
  const status = sidebarAgentStateLabel(state, t, format);
  if ((state.kind === "unread" || state.kind === "responded") && preview) return `${status} · ${preview}`;
  return status;
}

function rosterTimeLabel(time: RosterTime, t: AppTranslate): string {
  if (time.kind === "now") return t("sidebar.roster.time.now");
  if (time.kind === "quiet") return t("sidebar.roster.time.quiet");
  if (time.kind === "minutes") return t("sidebar.roster.time.minutes", { count: time.count });
  if (time.kind === "hours") return t("sidebar.roster.time.hours", { count: time.count });
  return t("sidebar.roster.time.days", { count: time.count });
}

function RosterRow(rowProps: { entry: RosterEntry; rising: boolean; now: number }) {
  const { props, touchRosterAgent } = useSidebarScope();
  const { t, format } = useText();
  const agent = () => props.agents.find((item) => item.id === rowProps.entry.id);
  const state = () => props.agentStates[rowProps.entry.id];
  const needsYou = () => state()?.kind === "waiting";
  const mood = (): AvatarMood => (rowProps.entry.asleep ? "asleep" : (props.agentMoods[rowProps.entry.id] ?? "idle"));
  const motion = () => (!rowProps.entry.asleep && props.activeAgentId === rowProps.entry.id ? "always" : "idle");
  const copy = () => {
    const current = agent();
    return current ? rosterCopy(current, state(), t, format) : "";
  };
  const time = () => rosterTimeLabel(rosterRelativeTime(rowProps.entry.activityAt, rowProps.now), t);
  const label = () => {
    const current = agent();
    if (!current) return "";
    const status = needsYou() ? `${copy()}. ${t("sidebar.roster.needsYou")}` : copy();
    return t("sidebar.roster.row", { name: current.name, status, time: time() });
  };
  return (
    <Show when={agent()}>
      {(current) => (
        <LabelTooltip content={label()} placement="right" class="roster-tooltip">
          <LabelTooltipTrigger
            as={Button}
            variant="ghost"
            type="button"
            class={[
              "roster-row",
              {
                "roster-row-asleep": rowProps.entry.asleep,
                "roster-row-rising": rowProps.rising,
                "roster-row-active": props.activeAgentId === current().id,
              },
            ]}
            data-category={rowProps.entry.category}
            aria-pressed={props.activeAgentId === current().id ? "true" : "false"}
            aria-label={label()}
            data-cuelume-navigate=""
            onClick={() => touchRosterAgent(current().id)}
          >
            <span class="roster-bar" aria-hidden="true" />
            <span class="roster-avatar">
              <span class="roster-ring roster-ring-outer" aria-hidden="true" />
              <span class="roster-ring" aria-hidden="true" />
              <AgentAvatar agent={current()} mood={mood()} motion={motion()} />
              <Show when={needsYou()}>
                <span class="roster-ask" aria-hidden="true">
                  ?
                </span>
              </Show>
            </span>
            <span class="roster-copy" aria-hidden="true">
              <span class="roster-name">
                <span class="roster-dot" />
                <strong>{current().name}</strong>
              </span>
              <span class="roster-status roster-status-short">{copy()}</span>
            </span>
            <span class="roster-time">{time()}</span>
          </LabelTooltipTrigger>
        </LabelTooltip>
      )}
    </Show>
  );
}

export function SidebarRoster() {
  const { props, rosterTouchedAt, scrollFades, setAgentListElement, userHiddenAgentList } = useSidebarScope();
  const { t, format } = useText();
  const [now, setNow] = createSignal(Date.now());
  const [filter, setFilter] = createSignal<RosterFilter>("all");
  const [rising, setRising] = createSignal<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = createSignal("");
  let riseTimer = 0;
  let previousAsleep: ReadonlySet<string> | null = null;
  let previousNeeds: ReadonlySet<string> | null = null;

  onSettled(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(riseTimer);
    };
  });

  const sources = createMemo((): RosterEntrySource[] => {
    const hidden = new Set(userHiddenAgentList().map((agent) => agent.id));
    return props.agents.flatMap((agent) =>
      hidden.has(agent.id)
        ? []
        : [
            {
              id: agent.id,
              name: agent.name,
              title: agent.title,
              description: agent.description,
              ...(agent.rosterCategory ? { rosterCategory: agent.rosterCategory } : {}),
              updatedAt: agent.updatedAt,
              awake: rosterKindKeepsAwake(props.agentStates[agent.id]?.kind),
            },
          ],
    );
  });
  const grouped = createMemo(() => partitionRoster(sources(), "all", { now: now(), touchedAt: rosterTouchedAt() }));
  const shown = createMemo(() => {
    const category = filter();
    if (category === "all") return grouped();
    return {
      active: grouped().active.filter((row) => row.category === category),
      asleep: grouped().asleep.filter((row) => row.category === category),
    };
  });
  const needsYouIds = createMemo(() =>
    sources().flatMap((source) => (props.agentStates[source.id]?.kind === "waiting" ? [source.id] : [])),
  );
  const cue = (): RosterCue | null => {
    const category = filter();
    if (category !== "all") return category;
    if (needsYouIds().length > 0) return "needsYou";
    if (grouped().asleep.length > 0) return "asleep";
    return null;
  };

  createEffect(
    () => {
      const names = new Map(props.agents.map((agent) => [agent.id, agent.name]));
      return { ids: grouped().asleep.map((row) => row.id), names };
    },
    (current) => {
      const ids = new Set(current.ids);
      const prior = previousAsleep;
      previousAsleep = ids;
      if (!prior) return;
      const woke = [...prior].filter((id) => !ids.has(id));
      const fell = current.ids.filter((id) => !prior.has(id));
      if (woke.length > 0) {
        setRising(new Set(woke));
        window.clearTimeout(riseTimer);
        riseTimer = window.setTimeout(() => setRising(new Set<string>()), 700);
        setNotice(
          t("sidebar.roster.woke", {
            name: format.list(woke.map((id) => current.names.get(id) ?? id)),
          }),
        );
      }
      if (fell.length > 0) playRosterSound("asleep");
    },
  );

  createEffect(needsYouIds, (ids) => {
    const prior = previousNeeds;
    previousNeeds = new Set(ids);
    if (!prior) return;
    if (ids.some((id) => !prior.has(id))) playRosterSound("needsYou");
  });

  const chooseFilter = (next: RosterFilter) => {
    setFilter(next);
    if (next !== "all") playRosterSound(next);
  };
  const visibleCount = () => shown().active.length + shown().asleep.length;

  return (
    <nav
      ref={setAgentListElement}
      class={["agent-list", "roster-list", scrollFades.classes()]}
      aria-label={t("sidebar.roster.title")}
      onScroll={scrollFades.measure}
    >
      <h2 class="roster-heading">
        <span class="roster-live" aria-hidden="true" />
        {t("sidebar.roster.title")}
      </h2>
      <fieldset class="roster-filters" aria-label={t("sidebar.roster.filterLabel")}>
        <For each={ROSTER_FILTERS}>
          {(category) => (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              class="roster-filter"
              data-category={category}
              aria-pressed={filter() === category ? "true" : "false"}
              onClick={() => chooseFilter(category)}
            >
              <Show when={category !== "all"}>
                <span class="roster-dot" data-category={category} aria-hidden="true" />
              </Show>
              {t(FILTER_LABEL[category])}
            </Button>
          )}
        </For>
      </fieldset>
      <Show
        when={visibleCount() > 0}
        fallback={
          <Show when={sources().length === 0} fallback={<p class="roster-empty">{t("sidebar.roster.emptyFilter")}</p>}>
            <SidebarEmptyState />
          </Show>
        }
      >
        <For each={shown().active}>
          {(entry) => <RosterRow entry={entry} rising={rising().has(entry.id)} now={now()} />}
        </For>
        <Show when={shown().asleep.length > 0}>
          <h3 class="roster-asleep-head">{t("sidebar.roster.asleep")}</h3>
          <For each={shown().asleep}>{(entry) => <RosterRow entry={entry} rising={false} now={now()} />}</For>
        </Show>
      </Show>
      <Show when={cue()}>
        {(current) => (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="roster-sound"
            data-category={current()}
            onClick={() => playRosterSound(current())}
          >
            <AudioLines aria-hidden="true" />
            {t(SOUND_LABEL[current()])}
            <span class="roster-eq" aria-hidden="true">
              <span class="roster-eq-bar" />
              <span class="roster-eq-bar" />
              <span class="roster-eq-bar" />
            </span>
          </Button>
        )}
      </Show>
      <span class="sr-only" role="status">
        {notice()}
      </span>
    </nav>
  );
}
