/**
 * The bots roster: who is in the list, in which group, and how quiet they are.
 *
 * Categories are not a database column. `rosterCategory` on an agent wins when a caller sets it.
 * Otherwise the title and the name are scanned for a group word. A description is ignored, because
 * it is long and it would mark too many agents. No word means worker.
 *
 * Group words, first match wins: monitor (monitor, watch, sentry, observer, alert), artist
 * (artist, paint, draw, doodle, design, illustrat), helper (helper, planner, life, notes,
 * personal, calendar), worker (worker, builder, engineer, developer).
 *
 * A row sleeps after 30 minutes with no activity, unless its state still needs a person or is
 * still running. A touch in this session counts as activity, so the row wakes and moves to the top.
 */

const ROSTER_CATEGORIES = ["monitor", "worker", "artist", "helper"] as const;
export type RosterCategory = (typeof ROSTER_CATEGORIES)[number];

export const ROSTER_FILTERS = ["all", ...ROSTER_CATEGORIES] as const;
export type RosterFilter = (typeof ROSTER_FILTERS)[number];

/** Quiet for this long and the row moves under Asleep. */
export const ROSTER_ASLEEP_AFTER_MS = 30 * 60 * 1000;

/** Avatar hue for each group, from the shared hue list. The saved hue of the agent stays as it is. */
export const ROSTER_CATEGORY_HUE = {
  monitor: 185,
  worker: 215,
  artist: 320,
  helper: 55,
} as const satisfies Record<RosterCategory, number>;

const CATEGORY_WORDS = {
  monitor: ["monitor", "watch", "sentry", "observer", "alert"],
  artist: ["artist", "paint", "draw", "doodle", "design", "illustrat"],
  helper: ["helper", "planner", "life", "notes", "personal", "calendar"],
  worker: ["worker", "builder", "engineer", "developer"],
} as const satisfies Record<RosterCategory, readonly string[]>;

/** Monitor and artist are more specific than the worker default, so they are tested first. */
const CATEGORY_SCAN: readonly RosterCategory[] = ["monitor", "artist", "helper", "worker"];

export interface RosterIdentity {
  name: string;
  title: string;
  description?: string | undefined;
  rosterCategory?: RosterCategory | undefined;
}

export interface RosterEntrySource extends RosterIdentity {
  id: string;
  updatedAt?: string | null | undefined;
  /** True when the agent still works or still waits. The clock does not put that row to sleep. */
  awake: boolean;
}

export interface RosterClock {
  now: number;
  touchedAt: Readonly<Record<string, number>>;
}

export interface RosterEntry {
  id: string;
  name: string;
  category: RosterCategory;
  activityAt: number;
  asleep: boolean;
}

export type RosterTime =
  | { kind: "now" }
  | { kind: "quiet" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "days"; count: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function isCategory(value: string | undefined): value is RosterCategory {
  return ROSTER_CATEGORIES.some((category) => category === value);
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}`, "i").test(text);
}

/** The group of one agent. See the file note for the word list and the default. */
export function rosterCategoryOf(agent: RosterIdentity): RosterCategory {
  if (isCategory(agent.rosterCategory)) return agent.rosterCategory;
  const text = `${agent.title} ${agent.name}`;
  for (const category of CATEGORY_SCAN) {
    if (CATEGORY_WORDS[category].some((word) => hasWord(text, word))) return category;
  }
  return "worker";
}

/**
 * Waiting, working, a routine, or a usage limit keeps the row in the active list.
 * A reply or an unread mark follows the activity clock instead.
 */
export function rosterKindKeepsAwake(kind: string | undefined): boolean {
  return kind === "waiting" || kind === "working" || kind === "routine" || kind === "limited";
}

/** The latest of the saved activity and a touch in this session. Zero when both are missing. */
function rosterActivityAt(source: RosterEntrySource, clock: RosterClock): number {
  const touched = clock.touchedAt[source.id] ?? 0;
  const parsed = source.updatedAt ? Date.parse(source.updatedAt) : Number.NaN;
  const updated = Number.isFinite(parsed) ? parsed : 0;
  return Math.max(updated, touched, 0);
}

function rosterIsAsleep(source: RosterEntrySource, clock: RosterClock): boolean {
  if (source.awake) return false;
  const activityAt = rosterActivityAt(source, clock);
  if (activityAt <= 0) return true;
  return clock.now - activityAt >= ROSTER_ASLEEP_AFTER_MS;
}

function byRecent(left: RosterEntry, right: RosterEntry): number {
  return right.activityAt - left.activityAt || left.name.localeCompare(right.name);
}

/** Active rows and asleep rows, newest first. A filter keeps one group, in both sections. */
export function partitionRoster(
  sources: readonly RosterEntrySource[],
  filter: RosterFilter,
  clock: RosterClock,
): { active: RosterEntry[]; asleep: RosterEntry[] } {
  const rows = sources
    .map((source): RosterEntry => {
      const activityAt = rosterActivityAt(source, clock);
      return {
        id: source.id,
        name: source.name,
        category: rosterCategoryOf(source),
        activityAt,
        asleep: rosterIsAsleep(source, clock),
      };
    })
    .filter((row) => filter === "all" || row.category === filter);
  return {
    active: rows.filter((row) => !row.asleep).sort(byRecent),
    asleep: rows.filter((row) => row.asleep).sort(byRecent),
  };
}

/** A label for the right side of a row: now, 8m, 2h, 1d, or quiet when there is no activity. */
export function rosterRelativeTime(activityAt: number, now: number): RosterTime {
  if (activityAt <= 0) return { kind: "quiet" };
  const elapsed = now - activityAt;
  if (elapsed < MINUTE_MS) return { kind: "now" };
  if (elapsed < HOUR_MS) return { kind: "minutes", count: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS) return { kind: "hours", count: Math.floor(elapsed / HOUR_MS) };
  return { kind: "days", count: Math.floor(elapsed / DAY_MS) };
}
