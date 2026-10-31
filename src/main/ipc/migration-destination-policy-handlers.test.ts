// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import {
  decodeMigrationDestinationPolicyState,
  MIGRATION_DESTINATION_POLICY,
  MIGRATION_DESTINATION_POLICY_UNAVAILABLE,
  type MigrationDestinationPolicyState,
} from "@openbot/contracts/ipc-migration-destination-policy";
import { MIGRATION_PREPARATION_BLOCKERS } from "@openbot/contracts/ipc-migration-preparation";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMigrationDestinationPolicyStateForRenderer } from "../../preload/migration-destination-policy-decoding";
import { MigrationDestinationPolicyService } from "../migration-destination-policy";
import { MigrationPreparationFailure, MigrationPreparationService } from "../migration-preparation";
import { MIGRATION_PREPARATION_JOURNAL } from "../migration-preparation-store";
import { registerIpcGroup } from "./define-ipc-group";
import { migrationDestinationPolicyIpcHandlers } from "./migration-destination-policy-handlers";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));
const TRUSTED = { senderFrame: { url: "openbot-app://app/index.html" } };
const UNTRUSTED = { senderFrame: { url: "https://invalid.example/index.html" } };
const CANARY = "SYNTHETIC_PRIVATE_POLICY_CANARY";
const roots: string[] = [];
beforeEach(() => {
  registrations.clear();
  vi.stubEnv("ELECTRON_RENDERER_URL", "");
});
afterEach(async () => {
  registrations.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function bind(service: MigrationDestinationPolicyService): void {
  registrations.clear();
  registerIpcGroup(
    "migrationDestinationPolicy",
    migrationDestinationPolicyIpcHandlers({ migrationDestinationPolicy: service }).migrationDestinationPolicy,
  );
}
async function invoke(payload?: unknown, event: unknown = TRUSTED): Promise<MigrationDestinationPolicyState> {
  const listener = registrations.get(IPC_ENDPOINTS.migrationDestinationPolicy.getState.channel);
  if (!listener) throw new Error("Policy handler missing.");
  return decodeMigrationDestinationPolicyStateForRenderer(await listener(event, payload));
}
async function failure(action: () => unknown): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Unexpected policy boundary failure.");
  }
  throw new Error("Policy boundary accepted a refused request.");
}
function redacted(error: Error, profile: string): void {
  const text = `${String(error)}\n${JSON.stringify(error)}`;
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(profile);
}
async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), "openbot-policy-ipc-"));
  roots.push(profile);
  const preparation = new MigrationPreparationService({
    userDataPath: profile,
    readInventory: () => Effect.succeed({ agents: 0, conversations: 0, messages: 0, attachments: 0, routines: 0 }),
  });
  await Effect.runPromise(preparation.prepare({ destinationKind: "docker-host", expectedRevision: 0 }));
  let reads = 0;
  const service = new MigrationDestinationPolicyService({
    platform: () => "darwin",
    preparation: {
      getState: () => {
        reads++;
        return preparation.getState();
      },
    },
  });
  bind(service);
  return { profile, preparation, service, reads: () => reads };
}
const decoders = [decodeMigrationDestinationPolicyState, decodeMigrationDestinationPolicyStateForRenderer];

describe("migration destination policy IPC and independent preload boundary", () => {
  it("rejects an untrusted sender before payload access or real service calls", async () => {
    const context = await fixture();
    const called = vi.spyOn(context.service, "getState");
    let inspected = 0;
    const payload = {
      get evidence() {
        inspected++;
        throw new Error(CANARY);
      },
    };
    const before = await readdir(context.profile);
    const error = await failure(() => invoke(payload, UNTRUSTED));
    expect(error.message).toBe("Rejected IPC request from an untrusted renderer.");
    redacted(error, context.profile);
    expect(inspected).toBe(0);
    expect(called).not.toHaveBeenCalled();
    expect(context.reads()).toBe(0);
    expect(await readdir(context.profile)).toEqual(before);
  });
  it("refuses every nonundefined payload including release tags keys evidence and synthetic receipts", async () => {
    const context = await fixture();
    const called = vi.spyOn(context.service, "getState");
    const before = await readFile(join(context.profile, MIGRATION_PREPARATION_JOURNAL));
    for (const payload of [
      null,
      false,
      true,
      0,
      "",
      CANARY,
      [],
      {},
      { tag: "v1.2.3" },
      { approvedReleaseTag: "v1.2.3" },
      { url: "https://invalid.example" },
      { publicKey: CANARY },
      { signature: CANARY },
      { sourceAuthority: CANARY },
      { evidence: { provenanceVerified: true } },
      { planId: CANARY, expectedRevision: 1 },
      {
        scope: "synthetic-only",
        authenticatedHostResponse: true,
        artifactMatch: "exact-synthetic-artifact",
        destinationVerified: false,
        runtimeAttested: false,
        blockers: [...MIGRATION_PREPARATION_BLOCKERS],
        operations: { export: false, restore: false, activate: false },
      },
    ])
      redacted(await failure(() => invoke(payload)), context.profile);
    expect(called).not.toHaveBeenCalled();
    expect(context.reads()).toBe(0);
    expect(await readFile(join(context.profile, MIGRATION_PREPARATION_JOURNAL))).toEqual(before);
  });
  it("passes undefined to the real service and independently decodes fixed blocked policy facts", async () => {
    const context = await fixture();
    const before = await readFile(join(context.profile, MIGRATION_PREPARATION_JOURNAL));
    const state = await invoke();
    expect(context.reads()).toBe(2);
    expect(state.policy).toEqual(MIGRATION_DESTINATION_POLICY);
    expect(state.approvedReleaseTag).toBeNull();
    expect(state.applicability).toBe("current");
    expect(state.phase).toBe("blocked");
    expect(state.unavailable).toEqual([...MIGRATION_DESTINATION_POLICY_UNAVAILABLE]);
    expect(state.blockers).toEqual([...MIGRATION_PREPARATION_BLOCKERS]);
    expect(Object.values(state.evidence)).toEqual([false, false, false, false, false]);
    expect(state.operations).toEqual({ export: false, restore: false, activate: false });
    expect(state.destinationVerified).toBe(false);
    expect(state.inventoryComplete).toBe(false);
    expect(await readFile(join(context.profile, MIGRATION_PREPARATION_JOURNAL))).toEqual(before);
    expect(decodeMigrationDestinationPolicyState(state)).toEqual(state);
  });
  it("redacts expected preparation failures asynchronous defects and synchronous port throws", async () => {
    const context = await fixture();
    const ports = [
      () => Effect.fail(new MigrationPreparationFailure({ code: "journal-invalid" })),
      () => Effect.die(new Error(`${CANARY}:${context.profile}`)),
      () => {
        throw new Error(`${CANARY}:${context.profile}`);
      },
    ];
    for (const port of ports) {
      bind(new MigrationDestinationPolicyService({ platform: () => "darwin", preparation: { getState: port } }));
      const error = await failure(() => invoke());
      expect(error.message).toBe(sourceText("error.migration.destinationPolicyReadFailed"));
      redacted(error, context.profile);
    }
  });
  it("refuses changed repository workflow issuer image release policy and caller authority fields", async () => {
    await fixture();
    const state = await invoke();
    const faults = [
      ...Object.keys(MIGRATION_DESTINATION_POLICY).map((key) => ({
        ...state,
        policy: { ...state.policy, [key]: "unapproved" },
      })),
      { ...state, approvedReleaseTag: "v1.2.3" },
      { ...state, policy: { ...state.policy, approved: true } },
      { ...state, sourceAuthority: CANARY },
      { ...state, signature: CANARY },
      { ...state, evidence: { ...state.evidence, signature: CANARY } },
      { ...state, operations: { ...state.operations, deploy: false } },
    ];
    for (const fault of faults)
      for (const decode of decoders) expect(() => decode(fault)).toThrow("Invalid migration destination policy state.");
  });
  it("refuses positive gates missing providers and inconsistent preparation bindings", async () => {
    await fixture();
    const state = await invoke();
    expect(state.preparation).not.toBeNull();
    if (!state.preparation) throw new Error("Synthetic policy binding missing.");
    const preparation = state.preparation;
    const inheritedUnavailable = [...state.unavailable];
    delete inheritedUnavailable[0];
    Object.assign(inheritedUnavailable, { tag: "v1.2.3" });
    Object.setPrototypeOf(inheritedUnavailable, { 0: state.unavailable[0] });
    const faults = [
      { ...state, destinationVerified: true },
      { ...state, inventoryComplete: true },
      ...Object.keys(state.evidence).map((key) => ({ ...state, evidence: { ...state.evidence, [key]: true } })),
      ...Object.keys(state.operations).map((key) => ({ ...state, operations: { ...state.operations, [key]: true } })),
      { ...state, unavailable: state.unavailable.slice(1) },
      { ...state, unavailable: Array(5).fill(state.unavailable[0]) },
      { ...state, unavailable: Array(5) },
      { ...state, unavailable: inheritedUnavailable },
      { ...state, blockers: Array(6) },
      { ...state, unavailable: Object.assign([...state.unavailable], { tag: "v1.2.3" }) },
      { ...state, blockers: Object.assign([...state.blockers], { sourceAuthority: CANARY }) },
      { ...state, blockers: state.blockers.slice(1) },
      { ...state, preparation: null },
      { ...state, preparation: { ...preparation, status: "cancelled" } },
      { ...state, preparation: { ...preparation, destinationKind: "local-desktop" } },
      { ...state, preparation: { ...preparation, revision: 0 } },
      { ...state, preparation: { ...preparation, revision: Number.NaN } },
      { ...state, preparation: { ...preparation, planId: `${preparation.planId}\n` } },
      { ...state, preparation: { ...preparation, extra: false } },
      { ...state, applicability: "none" },
      { ...state, phase: "out-of-scope" },
      { ...state, phase: "verified" },
    ];
    for (const fault of faults)
      for (const decode of decoders) expect(() => decode(fault)).toThrow("Invalid migration destination policy state.");
  });
  it("accepts stale after-read bindings without inventing current Docker applicability", async () => {
    await fixture();
    const state = await invoke();
    for (const decode of decoders) {
      expect(decode({ ...state, preparation: null, applicability: "stale", phase: "out-of-scope" }).applicability).toBe(
        "stale",
      );
      expect(decode({ ...state, applicability: "stale" }).phase).toBe("blocked");
    }
  });
});
