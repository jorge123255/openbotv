// @vitest-environment node

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC_ENDPOINTS, MIGRATION_PREPARATION_BLOCKERS, type MigrationPreparationState } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMigrationPreparationStateForRenderer } from "../../preload/migration-preparation-decoding";
import { MigrationPreparationService } from "../migration-preparation";
import { MIGRATION_PREPARATION_JOURNAL } from "../migration-preparation-store";
import { registerIpcGroup } from "./define-ipc-group";
import { migrationPreparationIpcHandlers } from "./migration-preparation-handlers";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, ...arguments_: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const TRUSTED = { senderFrame: { url: "openbot-app://app/index.html" } };
const UNTRUSTED = { senderFrame: { url: "https://invalid.example/index.html" } };
const METHODS = ["getState", "prepare", "cancel"] as const;
const INVENTORY = { agents: 2, conversations: 3, messages: 11, attachments: 4, routines: 2 };
const PRIVATE_CANARY = "synthetic-private-credential-never-return-this";
const OTHER_PLAN = "08014055-7076-446c-90d5-f2865b1065d0";
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

async function fixture(failInventory = false) {
  const profile = await mkdtemp(join(tmpdir(), "openbot-migration-preparation-ipc-"));
  roots.push(profile);
  let reads = 0;
  const service = new MigrationPreparationService({
    userDataPath: profile,
    now: () => "2026-01-01T09:00:00.000Z",
    readInventory: () => {
      reads++;
      return failInventory ? Effect.die(new Error(`${PRIVATE_CANARY}: ${profile}`)) : Effect.succeed({ ...INVENTORY });
    },
  });
  bind(service);
  return { profile, service, reads: () => reads };
}

function bind(service: MigrationPreparationService): void {
  registrations.clear();
  registerIpcGroup(
    "migrationPreparation",
    migrationPreparationIpcHandlers({ migrationPreparation: service }).migrationPreparation,
  );
}

async function invoke(
  method: (typeof METHODS)[number],
  payload?: unknown,
  event: unknown = TRUSTED,
): Promise<MigrationPreparationState> {
  const listener = registrations.get(IPC_ENDPOINTS.migrationPreparation[method].channel);
  if (!listener) throw new Error("The preparation handler is not registered.");
  return decodeMigrationPreparationStateForRenderer(await listener(event, payload));
}

async function state(method: (typeof METHODS)[number], payload?: unknown): Promise<MigrationPreparationState> {
  return invoke(method, payload);
}

async function failure(action: () => unknown): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("The boundary returned a non-error failure.");
  }
  throw new Error("The boundary accepted a refused request.");
}

function safeError(error: Error, profile: string): void {
  const exposed = `${String(error)}\n${JSON.stringify(error)}`;
  expect(exposed).not.toContain(PRIVATE_CANARY);
  expect(exposed).not.toContain(profile);
}

describe("migration preparation IPC trust and redaction", () => {
  it("rejects untrusted senders before inspecting input or accessing the journal or inventory", async () => {
    const context = await fixture();
    const serviceCalls = [
      vi.spyOn(context.service, "getState"),
      vi.spyOn(context.service, "prepare"),
      vi.spyOn(context.service, "cancel"),
    ];
    let inspected = 0;
    const input = {
      get destinationKind() {
        inspected++;
        throw new Error(PRIVATE_CANARY);
      },
      expectedRevision: 0,
    };
    for (const method of METHODS) {
      const error = await failure(() => invoke(method, input, UNTRUSTED));
      expect(error.message).toBe("Rejected IPC request from an untrusted renderer.");
      safeError(error, context.profile);
    }
    expect(inspected).toBe(0);
    for (const call of serviceCalls) expect(call).not.toHaveBeenCalled();
    expect(context.reads()).toBe(0);
    expect(await readdir(context.profile)).toEqual([]);
  });

  it("rejects unknown fields, unwanted state payloads and malformed revisions before inventory IO", async () => {
    const context = await fixture();
    const serviceCalls = [
      vi.spyOn(context.service, "getState"),
      vi.spyOn(context.service, "prepare"),
      vi.spyOn(context.service, "cancel"),
    ];
    for (const payload of [null, { serverId: PRIVATE_CANARY }, { path: context.profile }]) {
      safeError(await failure(() => invoke("getState", payload)), context.profile);
    }
    for (const payload of [
      null,
      { destinationKind: PRIVATE_CANARY, expectedRevision: 0 },
      { destinationKind: "docker-host", expectedRevision: -1 },
      { destinationKind: "docker-host", expectedRevision: 0.5 },
      { destinationKind: "docker-host", expectedRevision: Number.NaN },
      { destinationKind: "docker-host", expectedRevision: 2_147_483_648 },
      { destinationKind: "docker-host", expectedRevision: 0, serverId: PRIVATE_CANARY },
      { destinationKind: "docker-host", expectedRevision: 0, path: context.profile },
    ]) {
      safeError(await failure(() => invoke("prepare", payload)), context.profile);
    }
    for (const payload of [
      { planId: PRIVATE_CANARY, expectedRevision: 0 },
      { planId: `${OTHER_PLAN}\n`, expectedRevision: 0 },
      { planId: OTHER_PLAN, expectedRevision: -1 },
      { planId: OTHER_PLAN, expectedRevision: 0, secret: PRIVATE_CANARY },
      { planId: OTHER_PLAN, expectedRevision: 0, serverId: context.profile },
    ]) {
      safeError(await failure(() => invoke("cancel", payload)), context.profile);
    }
    for (const call of serviceCalls) expect(call).not.toHaveBeenCalled();
    expect(context.reads()).toBe(0);
    expect(await readdir(context.profile)).toEqual([]);
  });

  it("returns the same generic service error for stale revisions and unknown plan identities", async () => {
    const context = await fixture();
    const prepared = await state("prepare", { destinationKind: "docker-host", expectedRevision: 0 });
    if (!prepared.plan) throw new Error("The synthetic plan was not prepared.");
    const journal = join(context.profile, MIGRATION_PREPARATION_JOURNAL);
    const before = await readFile(journal);
    const inputs = [
      () => invoke("prepare", { destinationKind: "other-server", expectedRevision: 0 }),
      () => invoke("cancel", { planId: prepared.plan?.id, expectedRevision: 0 }),
      () => invoke("cancel", { planId: OTHER_PLAN, expectedRevision: 1 }),
    ];
    for (const action of inputs) {
      const error = await failure(action);
      expect(error.message).toBe(sourceText("error.migration.preparationFailed"));
      safeError(error, context.profile);
      expect(await readFile(journal)).toEqual(before);
      expect(await state("getState")).toEqual(prepared);
    }
    expect(context.reads()).toBe(1);
  });

  it("redacts private adapter defects and malformed private journal bytes", async () => {
    const context = await fixture(true);
    const adapterError = await failure(() =>
      invoke("prepare", { destinationKind: "local-desktop", expectedRevision: 0 }),
    );
    expect(adapterError.message).toBe(sourceText("error.migration.preparationFailed"));
    safeError(adapterError, context.profile);
    expect(await readdir(context.profile)).toEqual([]);
    expect(context.reads()).toBe(1);
    const journal = join(context.profile, MIGRATION_PREPARATION_JOURNAL);
    await writeFile(journal, `${PRIVATE_CANARY}\n${context.profile}`, { mode: 0o600, flag: "wx" });
    const before = await readFile(journal);
    const journalError = await failure(() => invoke("getState"));
    expect(journalError.message).toBe(sourceText("error.migration.preparationFailed"));
    safeError(journalError, context.profile);
    expect(await readFile(journal)).toEqual(before);
    expect(context.reads()).toBe(1);
  });

  it("uses the three registered channels to reload and cancel the real journal after service restart", async () => {
    const context = await fixture();
    expect([...registrations.keys()].sort()).toEqual(
      METHODS.map((method) => IPC_ENDPOINTS.migrationPreparation[method].channel).sort(),
    );
    expect(await state("getState")).toEqual({ revision: 0, plan: null });
    const prepared = await state("prepare", { destinationKind: "other-server", expectedRevision: 0 });
    if (!prepared.plan) throw new Error("The synthetic plan was not prepared.");
    expect(prepared.plan.inventory).toEqual(INVENTORY);
    expect(prepared.plan.blockers).toEqual([...MIGRATION_PREPARATION_BLOCKERS]);
    expect(prepared.plan.operations).toEqual({ export: false, restore: false, activate: false });
    let restartedReads = 0;
    bind(
      new MigrationPreparationService({
        userDataPath: context.profile,
        now: () => "2026-01-01T09:01:00.000Z",
        readInventory: () => {
          restartedReads++;
          return Effect.die(new Error(PRIVATE_CANARY));
        },
      }),
    );
    expect(await state("getState")).toEqual(prepared);
    const cancelled = await state("cancel", { planId: prepared.plan.id, expectedRevision: 1 });
    expect(cancelled.revision).toBe(2);
    expect(cancelled.plan?.status).toBe("cancelled");
    expect(cancelled.plan?.operations).toEqual({ export: false, restore: false, activate: false });
    expect(await state("getState")).toEqual(cancelled);
    expect(restartedReads).toBe(0);
  });

  it("refuses main responses that enable any operation or carry extra private data", async () => {
    const context = await fixture();
    const prepared = await state("prepare", { destinationKind: "local-desktop", expectedRevision: 0 });
    if (!prepared.plan) throw new Error("The synthetic plan was not prepared.");
    for (const operation of ["export", "restore", "activate"]) {
      const response = {
        ...prepared,
        plan: { ...prepared.plan, operations: { ...prepared.plan.operations, [operation]: true } },
      };
      safeError(await failure(() => decodeMigrationPreparationStateForRenderer(response)), context.profile);
    }
    for (const response of [
      { ...prepared, secret: PRIVATE_CANARY },
      { ...prepared, plan: { ...prepared.plan, path: context.profile } },
      { ...prepared, plan: { ...prepared.plan, blockers: [] } },
      { ...prepared, plan: { ...prepared.plan, inventory: { ...INVENTORY, messages: -1 } } },
    ]) {
      safeError(await failure(() => decodeMigrationPreparationStateForRenderer(response)), context.profile);
    }
    expect(await state("getState")).toEqual(prepared);
  });
});
