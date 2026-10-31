// Real generated database and preparation journal only. No evidence verifier, endpoint or app starts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  decodeMigrationDestinationPolicyState,
  MIGRATION_DESTINATION_POLICY_UNAVAILABLE,
  type MigrationDestinationPolicyState,
} from "@openbot/contracts/ipc-migration-destination-policy";
import { MIGRATION_PREPARATION_BLOCKERS } from "@openbot/contracts/ipc-migration-preparation";
import { Effect, Result } from "effect";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import {
  type MigrationDestinationPolicyFailure,
  MigrationDestinationPolicyService,
} from "../src/main/migration-destination-policy";
import { MigrationPreparationFailure, MigrationPreparationService } from "../src/main/migration-preparation";
import { readMigrationPreparationInventory } from "../src/main/migration-preparation-inventory";
import { MIGRATION_PREPARATION_JOURNAL } from "../src/main/migration-preparation-store";
import { decodeMigrationDestinationPolicyStateForRenderer } from "../src/preload/migration-destination-policy-decoding";

const output = resolve(import.meta.dirname, "../.openbot-build/migration-destination-policy-e2e");
const groups: Array<{ name: string; passed: boolean }> = [];
const EXPECTED_GROUPS = 10;
const CANARY = "SYNTHETIC_PRIVATE_POLICY_SOURCE_CANARY";
let base = "";
let database: OpenBotDatabase | null = null;
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function snapshot(): Promise<Array<{ path: string; kind: string; digest: string }>> {
  const entries: Array<{ path: string; kind: string; digest: string }> = [];
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    assert.ok(depth < 6 && entries.length < 100);
    for (const name of (await readdir(directory)).sort()) {
      // SQLite can update reader bookkeeping. Main DB and WAL bytes remain part of the proof.
      if (name === "openbot.db-shm") continue;
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const info = await lstat(path);
      if (info.isDirectory()) {
        entries.push({ path: relative, kind: "directory", digest: "" });
        await visit(path, `${relative}/`, depth + 1);
      } else {
        assert.ok(info.isFile());
        entries.push({ path: relative, kind: "file", digest: await hash(path) });
      }
    }
  }
  await visit(base, "", 0);
  return entries;
}
function validate(state: MigrationDestinationPolicyState): MigrationDestinationPolicyState {
  assert.deepEqual(decodeMigrationDestinationPolicyState(state), state);
  assert.deepEqual(decodeMigrationDestinationPolicyStateForRenderer(state), state);
  assert.deepEqual(state.policy, {
    repository: "jorge123255/openbotv",
    workflow: ".github/workflows/release.yml",
    issuer: "https://token.actions.githubusercontent.com",
    imageRepository: "ghcr.io/jorge123255/openbotv",
    sourceRuntime: "docker",
    destinationRuntime: "docker",
    releaseRef: "explicit-approved-tag",
    artifactIdentity: "oci-platform-manifest-and-config",
    buildMatch: "exact-same-linux-platform-artifacts",
  });
  assert.equal(state.approvedReleaseTag, null);
  assert.deepEqual(state.unavailable, [...MIGRATION_DESTINATION_POLICY_UNAVAILABLE]);
  assert.equal(state.unavailable.length, 5);
  assert.deepEqual(state.blockers, [...MIGRATION_PREPARATION_BLOCKERS]);
  assert.equal(state.blockers.length, 6);
  assert.deepEqual(state.evidence, {
    releaseApproved: false,
    provenanceVerified: false,
    runtimeBound: false,
    pairingApproved: false,
    sourceAuthenticated: false,
  });
  assert.equal(state.destinationVerified, false);
  assert.equal(state.inventoryComplete, false);
  assert.deepEqual(state.operations, { export: false, restore: false, activate: false });
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(CANARY) && !serialized.includes(base));
  return state;
}
async function unchanged(service: MigrationDestinationPolicyService): Promise<MigrationDestinationPolicyState> {
  const before = await snapshot();
  const state = validate(await Effect.runPromise(service.getState()));
  assert.deepEqual(await snapshot(), before);
  return state;
}
async function refused(
  operation: ReturnType<MigrationDestinationPolicyService["getState"]>,
  code: MigrationDestinationPolicyFailure["code"],
) {
  const result = await Effect.runPromise(Effect.result(operation));
  assert.ok(Result.isFailure(result));
  assert.deepEqual(result.failure.toJSON(), { _tag: "MigrationDestinationPolicyFailure", code });
}
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    assert.equal(database?.connection.prepare("SELECT count(*) AS n FROM projection_routine_runs").get()?.n, 0);
    groups.push({ name, passed: true });
  } catch {
    groups.push({ name, passed: false });
  }
  process.stdout.write(`${groups.at(-1)?.passed ? "pass" : "FAIL"} ${name}\n`);
}

try {
  assert.equal(process.argv.length, 2);
  await mkdir(output, { recursive: true, mode: 0o700 });
  base = await mkdtemp(join(output, "generated-"));
  const profile = join(base, "profile");
  database = new OpenBotDatabase(profile);
  await Effect.runPromise(database.initialize());
  await mkdir(join(base, "managed", "Agents", "synthetic"), { recursive: true, mode: 0o700 });
  await writeFile(join(base, "managed", "Agents", "synthetic", "source-canary"), CANARY, { mode: 0o600 });
  await writeFile(join(profile, "source-canary"), CANARY, { mode: 0o600 });
  const preparation = new MigrationPreparationService({
    userDataPath: profile,
    now: () => "2026-01-01T12:00:00.000Z",
    readInventory: () =>
      readMigrationPreparationInventory(() => {
        assert.ok(database);
        return database.connection;
      }),
  });
  let reads = 0;
  let platformReads = 0;
  const makeService = () =>
    new MigrationDestinationPolicyService({
      platform: () => {
        platformReads++;
        return "darwin";
      },
      preparation: {
        getState: () => {
          reads++;
          return preparation.getState();
        },
      },
    });

  await check("construction performs no platform preparation inventory or filesystem IO", async () => {
    const before = await snapshot();
    makeService();
    assert.equal(reads, 0);
    assert.equal(platformReads, 0);
    assert.deepEqual(await snapshot(), before);
  });
  await check("unprepared profile remains out of scope without creating a policy or preparation journal", async () => {
    const state = await unchanged(makeService());
    assert.equal(state.preparation, null);
    assert.equal(state.applicability, "none");
    assert.equal(state.phase, "out-of-scope");
    assert.ok(!(await readdir(profile)).includes(MIGRATION_PREPARATION_JOURNAL));
  });
  await check("local other server and cancelled plans remain out of scope", async () => {
    for (const destinationKind of ["local-desktop", "other-server"] as const) {
      const prior = await Effect.runPromise(preparation.getState());
      const prepared = await Effect.runPromise(
        preparation.prepare({ destinationKind, expectedRevision: prior.revision }),
      );
      assert.ok(prepared.plan);
      const state = await unchanged(makeService());
      assert.equal(state.phase, "out-of-scope");
      assert.equal(state.applicability, "none");
      assert.equal(state.preparation?.planId, prepared.plan.id);
      assert.equal(state.preparation?.destinationKind, destinationKind);
      await Effect.runPromise(preparation.cancel({ planId: prepared.plan.id, expectedRevision: prepared.revision }));
      const cancelled = await unchanged(makeService());
      assert.equal(cancelled.phase, "out-of-scope");
      assert.equal(cancelled.preparation?.status, "cancelled");
    }
  });
  await check("prepared Docker plan is current blocked with fixed policy null tag and all gates closed", async () => {
    const prior = await Effect.runPromise(preparation.getState());
    const prepared = await Effect.runPromise(
      preparation.prepare({ destinationKind: "docker-host", expectedRevision: prior.revision }),
    );
    assert.ok(prepared.plan);
    const state = await unchanged(makeService());
    assert.equal(state.phase, "blocked");
    assert.equal(state.applicability, "current");
    assert.deepEqual(state.preparation, {
      planId: prepared.plan.id,
      revision: prepared.revision,
      status: "prepared",
      destinationKind: "docker-host",
    });
  });
  await check(
    "repeated policy reads preserve generated filesystem database WAL canaries and journal bytes",
    async () => {
      const before = await snapshot();
      const count = reads;
      const first = await unchanged(makeService());
      assert.deepEqual(await unchanged(makeService()), first);
      assert.equal(reads - count, 4);
      assert.deepEqual(await snapshot(), before);
    },
  );
  await check(
    "actual cancellation between reads returns stale after binding without mutating cancelled state",
    async () => {
      const initial = await Effect.runPromise(preparation.getState());
      assert.ok(initial.plan);
      const plan = initial.plan;
      let calls = 0;
      let afterMutation: Awaited<ReturnType<typeof snapshot>> | null = null;
      const service = new MigrationDestinationPolicyService({
        platform: () => "darwin",
        preparation: {
          getState: () =>
            Effect.gen(function* () {
              calls++;
              if (calls === 2) {
                yield* preparation.cancel({ planId: plan.id, expectedRevision: initial.revision });
                afterMutation = yield* Effect.promise(snapshot);
              }
              return yield* preparation.getState();
            }),
        },
      });
      const state = validate(await Effect.runPromise(service.getState()));
      assert.equal(state.applicability, "stale");
      assert.equal(state.phase, "out-of-scope");
      assert.equal(state.preparation?.status, "cancelled");
      assert.equal(state.preparation?.revision, initial.revision + 1);
      assert.deepEqual(await snapshot(), afterMutation);
      assert.equal((await unchanged(makeService())).applicability, "none");
    },
  );
  await check("actual replacement between reads binds the new UUID and revision as stale then current", async () => {
    const prior = await Effect.runPromise(preparation.getState());
    const old = await Effect.runPromise(
      preparation.prepare({ destinationKind: "docker-host", expectedRevision: prior.revision }),
    );
    assert.ok(old.plan);
    const plan = old.plan;
    let calls = 0;
    let afterMutation: Awaited<ReturnType<typeof snapshot>> | null = null;
    const service = new MigrationDestinationPolicyService({
      platform: () => "darwin",
      preparation: {
        getState: () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 2) {
              const cancelled = yield* preparation.cancel({ planId: plan.id, expectedRevision: old.revision });
              yield* preparation.prepare({ destinationKind: "docker-host", expectedRevision: cancelled.revision });
              afterMutation = yield* Effect.promise(snapshot);
            }
            return yield* preparation.getState();
          }),
      },
    });
    const stale = validate(await Effect.runPromise(service.getState()));
    assert.equal(stale.applicability, "stale");
    assert.equal(stale.phase, "blocked");
    assert.notEqual(stale.preparation?.planId, plan.id);
    assert.equal(stale.preparation?.revision, old.revision + 2);
    assert.deepEqual(await snapshot(), afterMutation);
    const current = await unchanged(makeService());
    assert.equal(current.applicability, "current");
    assert.deepEqual(current.preparation, stale.preparation);
  });
  await check("Linux metadata status uses the same fixed blocked policy without claiming Docker evidence", async () => {
    const state = await unchanged(new MigrationDestinationPolicyService({ preparation, platform: () => "linux" }));
    assert.equal(state.phase, "blocked");
    assert.equal(state.applicability, "current");
  });
  await check("Windows and all other unsupported platforms refuse before any preparation port call", async () => {
    const before = await snapshot();
    for (const platform of ["win32", "aix", "android", "freebsd", "openbsd", "sunos"] as const) {
      let calls = 0;
      const service = new MigrationDestinationPolicyService({
        platform: () => platform,
        preparation: {
          getState: () => {
            calls++;
            return preparation.getState();
          },
        },
      });
      await refused(service.getState(), "unsupported-platform");
      assert.equal(calls, 0);
    }
    assert.deepEqual(await snapshot(), before);
  });
  await check(
    "expected failures defects and synchronous throws are fixed redacted failures without writes",
    async () => {
      const before = await snapshot();
      const ports = [
        () => Effect.fail(new MigrationPreparationFailure({ code: "journal-invalid" })),
        () => Effect.die(new Error(CANARY)),
        () => {
          throw new Error(CANARY);
        },
      ];
      for (const port of ports)
        await refused(
          new MigrationDestinationPolicyService({
            platform: () => "darwin",
            preparation: { getState: port },
          }).getState(),
          "preparation-unavailable",
        );
      assert.deepEqual(await snapshot(), before);
    },
  );
} catch {
  groups.push({ name: "generated-fixture-setup", passed: false });
} finally {
  try {
    database?.close();
  } catch {
    groups.push({ name: "owned-database-close", passed: false });
  }
  database = null;
  try {
    if (base) await rm(base, { recursive: true, force: true });
  } catch {
    groups.push({ name: "owned-fixture-cleanup", passed: false });
  }
  const passed = groups.length === EXPECTED_GROUPS && groups.every((group) => group.passed);
  try {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(
      join(output, "report.json"),
      `${JSON.stringify(
        {
          passed,
          expectedGroups: EXPECTED_GROUPS,
          groups,
          syntheticOnly: true,
          realGeneratedDatabase: true,
          realPreparationService: true,
          realPolicyService: true,
          independentPreloadDecoder: true,
          actualNetworkUsed: false,
          credentialsRead: false,
          newKeysGenerated: false,
          attestationVerifierUsed: false,
          signatureEvidenceAccepted: false,
          approvedReleaseTag: null,
          destinationVerified: false,
          inventoryComplete: false,
          operations: { export: false, restore: false, activate: false },
          limits: [
            "Fixed policy status only",
            "No attestation or OCI verification",
            "No tag approval",
            "Freshness binds only preparation UUID and revision",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    process.stdout.write("FAIL redacted-report-write\n");
    process.exitCode = 1;
  }
}
if (groups.length !== EXPECTED_GROUPS || groups.some((group) => !group.passed)) process.exitCode = 1;
