// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IPC_ENDPOINTS,
  MIGRATION_ASSESSMENT_CATEGORIES,
  MIGRATION_PREPARATION_BLOCKERS,
  type MigrationAssessmentInventory,
  type MigrationAssessmentState,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMigrationAssessmentStateForRenderer } from "../../preload/migration-assessment-decoding";
import { MigrationAssessmentService } from "../migration-assessment-service";
import { MigrationPreparationService } from "../migration-preparation";
import { registerIpcGroup } from "./define-ipc-group";
import { migrationAssessmentIpcHandlers } from "./migration-assessment-handlers";

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
const METHODS = ["getState", "assess"] as const;
const CANARY = "synthetic-private-assessment-token";
const DESTINATION = {
  platform: "darwin",
  architecture: "arm64",
  appVersion: "1.2.3",
  schemaVersion: 2,
  executor: "process",
  dataRoot: "owned",
  persistence: "persistent",
} as const;
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
function inventory(): MigrationAssessmentInventory {
  return {
    categories: MIGRATION_ASSESSMENT_CATEGORIES.map((category) => ({
      category,
      rowCount: null,
      countKind: "unknown",
      coverage: "not-inspected",
    })),
    schema: { expectedVersion: 2, observedVersion: 2, recognized: true, unmappedTables: 0 },
    paths: {
      managed: 0,
      userData: 0,
      external: 0,
      relative: 0,
      uri: 0,
      invalid: 0,
      defaults: 0,
      summaryReferences: 0,
      truncated: false,
      coverage: "not-inspected",
      containment: "lexical-only",
      symlinks: "not-inspected",
    },
    liveState: {
      providerSessions: null,
      pendingDeliveries: null,
      activeRoutines: null,
      workflowRuns: null,
      workflowSteps: null,
      pendingResultDeliveries: null,
      waits: null,
      confinedProcessAgents: null,
      countKind: "unknown",
    },
    credentials: { coverage: "not-inspected", reauthentication: "unresolved", deviceBound: "unknown" },
  };
}
function bind(service: MigrationAssessmentService): void {
  registrations.clear();
  registerIpcGroup(
    "migrationAssessment",
    migrationAssessmentIpcHandlers({ migrationAssessment: service }).migrationAssessment,
  );
}
async function invoke(
  method: (typeof METHODS)[number],
  payload?: unknown,
  event: unknown = TRUSTED,
): Promise<MigrationAssessmentState> {
  const listener = registrations.get(IPC_ENDPOINTS.migrationAssessment[method].channel);
  if (!listener) throw new Error("Assessment handler missing.");
  return decodeMigrationAssessmentStateForRenderer(await listener(event, payload));
}
async function fixture(prepared = true, failInventory = false) {
  const profile = await mkdtemp(join(tmpdir(), "openbot-migration-assessment-ipc-"));
  roots.push(profile);
  const preparation = new MigrationPreparationService({
    userDataPath: profile,
    readInventory: () => Effect.succeed({ agents: 1, conversations: 1, messages: 1, attachments: 0, routines: 0 }),
  });
  if (prepared) await Effect.runPromise(preparation.prepare({ destinationKind: "local-desktop", expectedRevision: 0 }));
  let reads = 0;
  const makeService = () =>
    new MigrationAssessmentService({
      userDataPath: profile,
      preparation,
      readSource: () => Effect.succeed({ platform: "darwin", architecture: "arm64", appVersion: "1.2.3" }),
      readInventory: () => {
        reads++;
        return failInventory ? Effect.die(new Error(`${CANARY}: ${profile}`)) : Effect.succeed(inventory());
      },
    });
  const service = makeService();
  bind(service);
  const input = async () => {
    const state = await Effect.runPromise(preparation.getState());
    if (!state.plan) throw new Error("Synthetic plan missing.");
    return {
      planId: state.plan.id,
      expectedPreparationRevision: state.revision,
      expectedAssessmentRevision: 0,
      destination: DESTINATION,
    };
  };
  return { profile, service, preparation, makeService, input, reads: () => reads };
}
async function refused(action: () => unknown, profile: string, localized = false): Promise<void> {
  let captured = false;
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error("Unexpected boundary failure.");
    captured = true;
    if (localized) expect(error.message).toBe(sourceText("error.migration.assessmentFailed"));
    const exposed = `${String(error)}\n${JSON.stringify(error)}`;
    expect(exposed).not.toContain(CANARY);
    expect(exposed).not.toContain(profile);
  }
  expect(captured).toBe(true);
}

describe("migration assessment IPC trust and redaction", () => {
  it("checks sender before decoding or invoking the real assessment service", async () => {
    const context = await fixture();
    const calls = [vi.spyOn(context.service, "getState"), vi.spyOn(context.service, "assess")];
    let touched = 0;
    const payload = {
      get planId() {
        touched++;
        throw new Error(CANARY);
      },
    };
    const names = await readdir(context.profile);
    for (const method of METHODS) await refused(() => invoke(method, payload, UNTRUSTED), context.profile);
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(touched).toBe(0);
    expect(context.reads()).toBe(0);
    expect(await readdir(context.profile)).toEqual(names);
  });
  it("rejects raw paths, key fields, malformed versions and unwanted state payloads before service IO", async () => {
    const context = await fixture();
    const input = await context.input();
    const calls = [vi.spyOn(context.service, "getState"), vi.spyOn(context.service, "assess")];
    for (const payload of [null, { serverId: CANARY }, { path: context.profile }])
      await refused(() => invoke("getState", payload), context.profile);
    for (const payload of [
      { ...input, serverId: CANARY },
      { ...input, path: context.profile },
      { ...input, expectedAssessmentRevision: 33 },
      { ...input, expectedPreparationRevision: -1 },
      { ...input, destination: { ...DESTINATION, token: CANARY } },
      { ...input, destination: { ...DESTINATION, url: "https://invalid.example" } },
      { ...input, destination: { ...DESTINATION, appVersion: "1.2.3\r" } },
      { ...input, destination: { ...DESTINATION, schemaVersion: Number.NaN } },
    ])
      await refused(() => invoke("assess", payload), context.profile);
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(context.reads()).toBe(0);
  });
  it("reloads durable informational reports, refuses stale writes, and marks cancelled links stale", async () => {
    const context = await fixture();
    const input = await context.input();
    const state = await invoke("assess", input);
    expect(state.applicability).toBe("current");
    expect(state.revision).toBe(1);
    expect(state.assessment?.blockers).toEqual([...MIGRATION_PREPARATION_BLOCKERS]);
    expect(state.assessment?.operations).toEqual({ export: false, restore: false, activate: false });
    expect(state.assessment?.destinationVerified).toBe(false);
    expect(state.assessment?.inventoryComplete).toBe(false);
    bind(context.makeService());
    expect(await invoke("getState")).toEqual(state);
    await refused(() => invoke("assess", input), context.profile, true);
    expect(context.reads()).toBe(1);
    await Effect.runPromise(context.preparation.cancel({ planId: input.planId, expectedRevision: 1 }));
    const stale = await invoke("getState");
    expect(stale.applicability).toBe("stale");
    expect(stale.assessment?.id).toBe(state.assessment?.id);
    await refused(() => invoke("assess", { ...input, expectedAssessmentRevision: 1 }), context.profile, true);
    await Effect.runPromise(context.preparation.prepare({ destinationKind: "docker-host", expectedRevision: 2 }));
    const replacement = await invoke("getState");
    expect(replacement.applicability).toBe("none");
    expect(replacement.assessment).toBeNull();
    expect(replacement.revision).toBe(0);
  });
  it("redacts adapter defects and corrupt report bytes without resetting the record", async () => {
    const failed = await fixture(true, true);
    await refused(async () => invoke("assess", await failed.input()), failed.profile, true);
    expect((await invoke("getState")).assessment).toBeNull();
    const context = await fixture();
    const input = await context.input();
    await invoke("assess", input);
    const path = join(context.profile, "openbot-migration-assessments-v1", input.planId, "1.json");
    await writeFile(path, `${CANARY}\n${context.profile}`);
    const before = await readFile(path);
    await refused(() => invoke("getState"), context.profile, true);
    expect(await readFile(path)).toEqual(before);
  });
  it("keeps missing preparation empty and rejects privileged or inconsistent main responses", async () => {
    const empty = await fixture(false);
    expect(await invoke("getState")).toEqual({
      preparation: null,
      revision: 0,
      applicability: "none",
      assessment: null,
    });
    expect(await readdir(empty.profile)).toEqual([]);
    const context = await fixture();
    const state = await invoke("assess", await context.input());
    if (!state.assessment) throw new Error("Synthetic assessment missing.");
    for (const assessment of [
      { ...state.assessment, destinationVerified: true },
      { ...state.assessment, inventoryComplete: true },
      { ...state.assessment, operations: { export: true, restore: false, activate: false } },
      { ...state.assessment, token: CANARY },
      { ...state.assessment, inventory: { ...state.assessment.inventory, categories: [] } },
      {
        ...state.assessment,
        inventory: {
          ...state.assessment.inventory,
          liveState: { ...state.assessment.inventory.liveState, providerSessions: 0 },
        },
      },
    ])
      await refused(() => decodeMigrationAssessmentStateForRenderer({ ...state, assessment }), context.profile);
    await refused(
      () =>
        decodeMigrationAssessmentStateForRenderer({
          ...state,
          preparation: { ...state.preparation, status: "cancelled" },
        }),
      context.profile,
    );
    expect(await invoke("getState")).toEqual(state);
  });
});
