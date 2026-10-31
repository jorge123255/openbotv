import {
  MIGRATION_PREPARATION_BLOCKERS,
  MIGRATION_PREPARATION_DESTINATIONS,
  MIGRATION_PREPARATION_MAX_COUNT,
  type MigrationPreparationBlocker,
  type MigrationPreparationDestinationKind,
} from "./ipc-migration-preparation";
import { type DynamicRecord, isDynamicRecord, isOneOf } from "./runtime-values";

/** Approved policy scope, not evidence that a build or destination meets it. */
export const MIGRATION_DESTINATION_POLICY = Object.freeze({
  repository: "jorge123255/openbotv",
  workflow: ".github/workflows/release.yml",
  issuer: "https://token.actions.githubusercontent.com",
  imageRepository: "ghcr.io/jorge123255/openbotv",
  sourceRuntime: "docker",
  destinationRuntime: "docker",
  releaseRef: "explicit-approved-tag",
  artifactIdentity: "oci-platform-manifest-and-config",
  buildMatch: "exact-same-linux-platform-artifacts",
} as const);
export const MIGRATION_DESTINATION_POLICY_UNAVAILABLE = Object.freeze([
  "approved-release-tag-unavailable",
  "attestation-verifier-unavailable",
  "runtime-binding-unavailable",
  "pairing-approval-unavailable",
  "source-authentication-unavailable",
] as const);

export interface MigrationDestinationPolicyPreparation {
  planId: string;
  revision: number;
  status: "prepared" | "cancelled";
  destinationKind: MigrationPreparationDestinationKind;
}
export interface MigrationDestinationPolicyState {
  policy: typeof MIGRATION_DESTINATION_POLICY;
  approvedReleaseTag: null;
  preparation: MigrationDestinationPolicyPreparation | null;
  applicability: "none" | "current" | "stale";
  phase: "blocked" | "out-of-scope";
  unavailable: Array<(typeof MIGRATION_DESTINATION_POLICY_UNAVAILABLE)[number]>;
  evidence: {
    releaseApproved: false;
    provenanceVerified: false;
    runtimeBound: false;
    pairingApproved: false;
    sourceAuthenticated: false;
  };
  blockers: MigrationPreparationBlocker[];
  destinationVerified: false;
  inventoryComplete: false;
  operations: { export: false; restore: false; activate: false };
}

function invalid(): never {
  throw new Error("Invalid migration destination policy state.");
}
function record(value: unknown, keys: readonly string[]): DynamicRecord {
  if (
    !isDynamicRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value;
}
function exactList(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    Object.keys(value).length === expected.length &&
    expected.every((entry, index) => Object.hasOwn(value, index) && value[index] === entry)
  );
}
function preparation(value: unknown): MigrationDestinationPolicyPreparation | null {
  if (value === null) return null;
  const input = record(value, ["planId", "revision", "status", "destinationKind"]);
  if (
    typeof input.planId !== "string" ||
    input.planId.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.planId) ||
    typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.revision > MIGRATION_PREPARATION_MAX_COUNT ||
    !isOneOf(["prepared", "cancelled"] as const, input.status) ||
    !isOneOf(MIGRATION_PREPARATION_DESTINATIONS, input.destinationKind)
  )
    invalid();
  return {
    planId: input.planId,
    revision: input.revision,
    status: input.status,
    destinationKind: input.destinationKind,
  };
}

export function decodeMigrationDestinationPolicyState(value: unknown): MigrationDestinationPolicyState {
  const input = record(value, [
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
  const policy = record(input.policy, Object.keys(MIGRATION_DESTINATION_POLICY));
  for (const [key, expected] of Object.entries(MIGRATION_DESTINATION_POLICY)) {
    if (policy[key] !== expected) invalid();
  }
  if (
    input.approvedReleaseTag !== null ||
    input.destinationVerified !== false ||
    input.inventoryComplete !== false ||
    !isOneOf(["none", "current", "stale"] as const, input.applicability) ||
    !isOneOf(["blocked", "out-of-scope"] as const, input.phase)
  )
    invalid();
  const binding = preparation(input.preparation);
  const applicable = binding?.status === "prepared" && binding.destinationKind === "docker-host";
  if (
    (input.phase === "blocked") !== applicable ||
    (input.applicability === "current" && !applicable) ||
    (input.applicability === "none" && applicable)
  )
    invalid();
  const evidence = record(input.evidence, [
    "releaseApproved",
    "provenanceVerified",
    "runtimeBound",
    "pairingApproved",
    "sourceAuthenticated",
  ]);
  if (Object.values(evidence).some((entry) => entry !== false)) invalid();
  const operations = record(input.operations, ["export", "restore", "activate"]);
  if (Object.values(operations).some((entry) => entry !== false)) invalid();
  if (
    !exactList(input.unavailable, MIGRATION_DESTINATION_POLICY_UNAVAILABLE) ||
    !exactList(input.blockers, MIGRATION_PREPARATION_BLOCKERS)
  )
    invalid();
  return {
    policy: MIGRATION_DESTINATION_POLICY,
    approvedReleaseTag: null,
    preparation: binding,
    applicability: input.applicability,
    phase: input.phase,
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
