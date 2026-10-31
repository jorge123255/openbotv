import {
  MIGRATION_DESTINATION_POLICY,
  MIGRATION_DESTINATION_POLICY_UNAVAILABLE,
  type MigrationDestinationPolicyPreparation,
  type MigrationDestinationPolicyState,
} from "@openbot/contracts/ipc-migration-destination-policy";
import {
  MIGRATION_PREPARATION_BLOCKERS,
  MIGRATION_PREPARATION_DESTINATIONS,
  MIGRATION_PREPARATION_MAX_COUNT,
} from "@openbot/contracts/ipc-migration-preparation";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";

function invalid(): never {
  throw new Error("Invalid migration destination policy state.");
}
function closed(value: unknown, keys: readonly string[]): DynamicRecord {
  if (
    !isDynamicRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value;
}
function choice<T extends string>(values: readonly T[], value: unknown): T {
  for (const candidate of values) if (value === candidate) return candidate;
  return invalid();
}
function link(value: unknown): MigrationDestinationPolicyPreparation | null {
  if (value === null) return null;
  const input = closed(value, ["planId", "revision", "status", "destinationKind"]);
  if (
    typeof input.planId !== "string" ||
    input.planId.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.planId) ||
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.revision > MIGRATION_PREPARATION_MAX_COUNT
  )
    invalid();
  return {
    planId: input.planId,
    revision: input.revision,
    status: choice(["prepared", "cancelled"] as const, input.status),
    destinationKind: choice(MIGRATION_PREPARATION_DESTINATIONS, input.destinationKind),
  };
}
function exactList(value: unknown, expected: readonly string[]): void {
  if (!Array.isArray(value) || value.length !== expected.length || Object.keys(value).length !== expected.length)
    invalid();
  for (let index = 0; index < expected.length; index++)
    if (!Object.hasOwn(value, index) || value[index] !== expected[index]) invalid();
}

/** Independent FromMain decoder. It accepts fixed blocked policy facts, never caller evidence. */
export function decodeMigrationDestinationPolicyStateForRenderer(value: unknown): MigrationDestinationPolicyState {
  const input = closed(value, [
    "policy",
    "approvedReleaseTag",
    "preparation",
    "applicability",
    "phase",
    "unavailable",
    "evidence",
    "blockers",
    "destinationVerified",
    "inventoryComplete",
    "operations",
  ]);
  const policy = closed(input.policy, Object.keys(MIGRATION_DESTINATION_POLICY));
  for (const [key, expected] of Object.entries(MIGRATION_DESTINATION_POLICY)) if (policy[key] !== expected) invalid();
  if (input.approvedReleaseTag !== null || input.destinationVerified !== false || input.inventoryComplete !== false)
    invalid();
  const preparation = link(input.preparation);
  const applicability = choice(["none", "current", "stale"] as const, input.applicability);
  const phase = choice(["blocked", "out-of-scope"] as const, input.phase);
  const applicable = preparation?.status === "prepared" && preparation.destinationKind === "docker-host";
  if (
    (phase === "blocked") !== applicable ||
    (applicability === "current" && !applicable) ||
    (applicability === "none" && applicable)
  )
    invalid();
  const evidence = closed(input.evidence, [
    "releaseApproved",
    "provenanceVerified",
    "runtimeBound",
    "pairingApproved",
    "sourceAuthenticated",
  ]);
  if (Object.values(evidence).some((entry) => entry !== false)) invalid();
  const operations = closed(input.operations, ["export", "restore", "activate"]);
  if (Object.values(operations).some((entry) => entry !== false)) invalid();
  exactList(input.unavailable, MIGRATION_DESTINATION_POLICY_UNAVAILABLE);
  exactList(input.blockers, MIGRATION_PREPARATION_BLOCKERS);
  return {
    policy: MIGRATION_DESTINATION_POLICY,
    approvedReleaseTag: null,
    preparation,
    applicability,
    phase,
    unavailable: [...MIGRATION_DESTINATION_POLICY_UNAVAILABLE],
    evidence: {
      releaseApproved: false,
      provenanceVerified: false,
      runtimeBound: false,
      pairingApproved: false,
      sourceAuthenticated: false,
    },
    blockers: [...MIGRATION_PREPARATION_BLOCKERS],
    destinationVerified: false,
    inventoryComplete: false,
    operations: { export: false, restore: false, activate: false },
  };
}
