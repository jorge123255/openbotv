import {
  MIGRATION_PREPARATION_BLOCKERS,
  MIGRATION_PREPARATION_DESTINATIONS,
  MIGRATION_PREPARATION_MAX_COUNT,
  type MigrationPreparationState,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";

function exactRecord(value: unknown, keys: readonly string[]): DynamicRecord {
  if (
    !isDynamicRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid migration preparation state from main.");
  return value;
}

function boundedCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MIGRATION_PREPARATION_MAX_COUNT)
    throw new Error("Invalid migration preparation count from main.");
  return value;
}

function canonicalDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Invalid migration preparation date from main.");
  return value;
}

/** Independent main-to-renderer validation. No host or contract response decoder is reused. */
export function decodeMigrationPreparationStateForRenderer(value: unknown): MigrationPreparationState {
  const state = exactRecord(value, ["revision", "plan"]);
  const revision = boundedCount(state.revision);
  if (state.plan === null) return { revision, plan: null };
  const plan = exactRecord(state.plan, [
    "id",
    "createdAt",
    "updatedAt",
    "status",
    "destinationKind",
    "inventory",
    "observation",
    "blockers",
    "operations",
  ]);
  if (
    typeof plan.id !== "string" ||
    plan.id.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(plan.id) ||
    !isOneOf(["prepared", "cancelled"] as const, plan.status) ||
    !isOneOf(MIGRATION_PREPARATION_DESTINATIONS, plan.destinationKind) ||
    plan.observation !== "metadata-only"
  )
    throw new Error("Invalid migration preparation plan from main.");
  const inventory = exactRecord(plan.inventory, ["agents", "conversations", "messages", "attachments", "routines"]);
  const operations = exactRecord(plan.operations, ["export", "restore", "activate"]);
  if (operations.export !== false || operations.restore !== false || operations.activate !== false)
    throw new Error("Migration preparation cannot enable an operation from main.");
  if (!Array.isArray(plan.blockers) || plan.blockers.length !== MIGRATION_PREPARATION_BLOCKERS.length)
    throw new Error("Invalid migration preparation blockers from main.");
  const blockers = plan.blockers.map((blocker) => {
    if (!isOneOf(MIGRATION_PREPARATION_BLOCKERS, blocker))
      throw new Error("Invalid migration preparation blocker from main.");
    return blocker;
  });
  if (new Set(blockers).size !== MIGRATION_PREPARATION_BLOCKERS.length)
    throw new Error("Invalid migration preparation blockers from main.");
  const createdAt = canonicalDate(plan.createdAt);
  const updatedAt = canonicalDate(plan.updatedAt);
  if (updatedAt < createdAt) throw new Error("Invalid migration preparation chronology from main.");
  return {
    revision,
    plan: {
      id: plan.id,
      createdAt,
      updatedAt,
      status: plan.status,
      destinationKind: plan.destinationKind,
      inventory: {
        agents: boundedCount(inventory.agents),
        conversations: boundedCount(inventory.conversations),
        messages: boundedCount(inventory.messages),
        attachments: boundedCount(inventory.attachments),
        routines: boundedCount(inventory.routines),
      },
      observation: "metadata-only",
      blockers,
      operations: { export: false, restore: false, activate: false },
    },
  };
}
