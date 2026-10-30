/**
 * Checks the bots roster model: order, category, quiet time, and wake.
 * Writes `.openbot-build/roster-model.json`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import {
  partitionRoster,
  ROSTER_ASLEEP_AFTER_MS,
  type RosterEntrySource,
  rosterCategoryOf,
  rosterKindKeepsAwake,
  rosterRelativeTime,
} from "../packages/ui/src/features/sidebar/roster-model";

const logger = createOpenBotLogger("roster-model");
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function source(patch: Partial<RosterEntrySource> & Pick<RosterEntrySource, "id" | "name">): RosterEntrySource {
  return {
    title: "",
    awake: false,
    ...patch,
  };
}

const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) failures.push(`${name}: ${left} !== ${right}`);
}

check("asleep threshold is 30 minutes", ROSTER_ASLEEP_AFTER_MS, 30 * MINUTE);

check(
  "explicit category wins over the title",
  rosterCategoryOf({ name: "Orbit Watch", title: "Monitor", rosterCategory: "artist" }),
  "artist",
);

check("title word sets the category", rosterCategoryOf({ name: "Ada", title: "Moon Painter" }), "artist");
check("name word sets the category", rosterCategoryOf({ name: "Pocket Planner", title: "" }), "helper");
check(
  "description is not a category",
  rosterCategoryOf({ name: "Ada", title: "Partner", description: "artist and painter" }),
  "worker",
);
check("unknown role defaults to worker", rosterCategoryOf({ name: "Ada", title: "Partner" }), "worker");

check("waiting stays awake", rosterKindKeepsAwake("waiting"), true);
check("a reply follows the clock", rosterKindKeepsAwake("responded"), false);
check("no state follows the clock", rosterKindKeepsAwake(undefined), false);

const agents = [
  source({ id: "rocket", name: "Rocket Smith", title: "Worker", updatedAt: new Date(NOW - 1_000).toISOString() }),
  source({
    id: "orbit",
    name: "Orbit Watch",
    title: "Monitor",
    updatedAt: new Date(NOW - 20_000).toISOString(),
  }),
  source({
    id: "moon",
    name: "Moon Painter",
    title: "Artist",
    updatedAt: new Date(NOW - 8 * MINUTE).toISOString(),
  }),
  source({
    id: "pocket",
    name: "Pocket Planner",
    title: "Life helper",
    awake: true,
    updatedAt: new Date(NOW - 19 * MINUTE).toISOString(),
  }),
  source({
    id: "late",
    name: "Late Wait",
    title: "Worker",
    awake: true,
    updatedAt: new Date(NOW - 3 * 60 * MINUTE).toISOString(),
  }),
  source({
    id: "star",
    name: "Star Doodle",
    title: "Artist",
    updatedAt: new Date(NOW - 2 * 60 * MINUTE).toISOString(),
  }),
  source({ id: "quiet", name: "Quiet", title: "" }),
];

const all = partitionRoster(agents, "all", { now: NOW, touchedAt: {} });
check(
  "newest active rows come first",
  all.active.map((row) => row.id),
  ["rocket", "orbit", "moon", "pocket", "late"],
);
check(
  "quiet rows sleep",
  all.asleep.map((row) => row.id),
  ["star", "quiet"],
);
check("a waiting row stays active", all.active.find((row) => row.id === "pocket")?.asleep, false);

const workers = partitionRoster(agents, "worker", { now: NOW, touchedAt: {} });
check(
  "a category filter keeps that category",
  [...workers.active, ...workers.asleep].map((row) => row.category),
  ["worker", "worker", "worker"],
);

const woke = partitionRoster(agents, "all", { now: NOW, touchedAt: { star: NOW } });
check("a touch wakes a quiet row to the top", woke.active[0]?.id, "star");
check(
  "the woken row leaves the asleep group",
  woke.asleep.map((row) => row.id),
  ["quiet"],
);

const edge = source({ id: "edge", name: "Edge", updatedAt: new Date(NOW - ROSTER_ASLEEP_AFTER_MS).toISOString() });
check("30 minutes is asleep", partitionRoster([edge], "all", { now: NOW, touchedAt: {} }).asleep.length, 1);
const justAwake = source({
  id: "edge",
  name: "Edge",
  updatedAt: new Date(NOW - ROSTER_ASLEEP_AFTER_MS + 1).toISOString(),
});
check(
  "just under 30 minutes stays active",
  partitionRoster([justAwake], "all", { now: NOW, touchedAt: {} }).active.length,
  1,
);

check("now", rosterRelativeTime(NOW, NOW), { kind: "now" });
check("under a minute is now", rosterRelativeTime(NOW - 30_000, NOW), { kind: "now" });
check("eight minutes", rosterRelativeTime(NOW - 8 * MINUTE, NOW), { kind: "minutes", count: 8 });
check("two hours", rosterRelativeTime(NOW - 2 * 60 * MINUTE, NOW), { kind: "hours", count: 2 });
check("five hours", rosterRelativeTime(NOW - 5 * 60 * MINUTE, NOW), { kind: "hours", count: 5 });
check("no activity is quiet", rosterRelativeTime(0, NOW), { kind: "quiet" });

const sameTime = partitionRoster(
  [
    source({ id: "b", name: "Beta", updatedAt: new Date(NOW - MINUTE).toISOString() }),
    source({ id: "a", name: "Alpha", updatedAt: new Date(NOW - MINUTE).toISOString() }),
  ],
  "all",
  { now: NOW, touchedAt: {} },
);
check(
  "equal times sort by name",
  sameTime.active.map((row) => row.id),
  ["a", "b"],
);

const report = { ok: failures.length === 0, failures };
const path = resolve(import.meta.dirname, "../.openbot-build/roster-model.json");
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  logger.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  logger.info(`Roster model checks passed. Wrote ${path}.`);
}
