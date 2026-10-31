import { type DynamicRecord, isDynamicRecord, isOneOf } from "./runtime-values";

export const MIGRATION_PREPARATION_BLOCKERS = [
  "destination-unconfigured",
  "snapshot-unavailable",
  "credentials-unavailable",
  "fencing-unavailable",
  "restore-unavailable",
  "activation-unavailable",
] as const;
export const MIGRATION_PREPARATION_DESTINATIONS = ["local-desktop", "docker-host", "other-server"] as const;
export const MIGRATION_PREPARATION_MAX_COUNT = 2_147_483_647;

export type MigrationPreparationDestinationKind = (typeof MIGRATION_PREPARATION_DESTINATIONS)[number];
export type MigrationPreparationBlocker = (typeof MIGRATION_PREPARATION_BLOCKERS)[number];

export interface MigrationPreparationInventory {
  agents: number;
  conversations: number;
  messages: number;
  attachments: number;
  routines: number;
}

export interface MigrationPreparationPlan {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "prepared" | "cancelled";
  destinationKind: MigrationPreparationDestinationKind;
  inventory: MigrationPreparationInventory;
  observation: "metadata-only";
  blockers: MigrationPreparationBlocker[];
  operations: { export: false; restore: false; activate: false };
}

export interface MigrationPreparationState {
  revision: number;
  plan: MigrationPreparationPlan | null;
}

export interface MigrationPreparationPrepareInput {
  destinationKind: MigrationPreparationDestinationKind;
  expectedRevision: number;
}

export interface MigrationPreparationCancelInput {
  planId: string;
  expectedRevision: number;
}

function record(value: unknown, keys: readonly string[]): DynamicRecord {
  if (
    !isDynamicRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid migration preparation payload.");
  return value;
}

function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MIGRATION_PREPARATION_MAX_COUNT)
    throw new Error("Invalid migration preparation counter.");
  return value;
}

function planId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    throw new Error("Invalid migration preparation plan ID.");
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("Invalid migration preparation timestamp.");
  return value;
}

export function parseMigrationPreparationPrepareInput(value: unknown): MigrationPreparationPrepareInput {
  const input = record(value, ["destinationKind", "expectedRevision"]);
  if (!isOneOf(MIGRATION_PREPARATION_DESTINATIONS, input.destinationKind))
    throw new Error("Invalid migration preparation destination.");
  return { destinationKind: input.destinationKind, expectedRevision: counter(input.expectedRevision) };
}

export function parseMigrationPreparationCancelInput(value: unknown): MigrationPreparationCancelInput {
  const input = record(value, ["planId", "expectedRevision"]);
  return { planId: planId(input.planId), expectedRevision: counter(input.expectedRevision) };
}

export function decodeMigrationPreparationState(value: unknown): MigrationPreparationState {
  const state = record(value, ["revision", "plan"]);
  const revision = counter(state.revision);
  if (state.plan === null) return { revision, plan: null };
  const plan = record(state.plan, [
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
    !isOneOf(["prepared", "cancelled"] as const, plan.status) ||
    !isOneOf(MIGRATION_PREPARATION_DESTINATIONS, plan.destinationKind) ||
    plan.observation !== "metadata-only"
  )
    throw new Error("Invalid migration preparation plan.");
  const inventory = record(plan.inventory, ["agents", "conversations", "messages", "attachments", "routines"]);
  const operations = record(plan.operations, ["export", "restore", "activate"]);
  if (operations.export !== false || operations.restore !== false || operations.activate !== false)
    throw new Error("Migration preparation cannot enable an operation.");
  if (!Array.isArray(plan.blockers) || plan.blockers.length !== MIGRATION_PREPARATION_BLOCKERS.length)
    throw new Error("Invalid migration preparation blockers.");
  const blockers = plan.blockers.map((blocker) => {
    if (!isOneOf(MIGRATION_PREPARATION_BLOCKERS, blocker)) throw new Error("Invalid migration preparation blocker.");
    return blocker;
  });
  if (new Set(blockers).size !== MIGRATION_PREPARATION_BLOCKERS.length)
    throw new Error("Invalid migration preparation blockers.");
  const createdAt = timestamp(plan.createdAt);
  const updatedAt = timestamp(plan.updatedAt);
  if (updatedAt < createdAt) throw new Error("Invalid migration preparation chronology.");
  return {
    revision,
    plan: {
      id: planId(plan.id),
      createdAt,
      updatedAt,
      status: plan.status,
      destinationKind: plan.destinationKind,
      inventory: {
        agents: counter(inventory.agents),
        conversations: counter(inventory.conversations),
        messages: counter(inventory.messages),
        attachments: counter(inventory.attachments),
        routines: counter(inventory.routines),
      },
      observation: "metadata-only",
      blockers,
      operations: { export: false, restore: false, activate: false },
    },
  };
}
