// Drives only the synthetic SQLite writer model. Evidence is self-reported. No host, application,
// provider, credential store, network endpoint, or production database is opened or controlled.
// Run with: node --import tsx scripts/instance-migration-writer-e2e.ts

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Result } from "effect";
import {
  type SyntheticWriterEvidence,
  type SyntheticWriterFailure,
  SyntheticWriterGuard,
  type SyntheticWriterSnapshot,
} from "./migration-lab/writer-guard";

const root = resolve(".openbot-build/instance-migration-writer-e2e");
const groups: Array<{ name: string; passed: boolean }> = [];
const handles: SyntheticWriterGuard[] = [];
const ready: SyntheticWriterEvidence = {
  syntheticOnly: true,
  inventoryComplete: true,
  snapshotVerified: true,
  restoreVerified: true,
  rehearsalOffline: true,
  backupVerified: true,
  secrets: "verified",
};

async function create(): Promise<SyntheticWriterGuard> {
  const guard = await Effect.runPromise(SyntheticWriterGuard.create());
  handles.push(guard);
  return guard;
}

async function snapshot(guard: SyntheticWriterGuard): Promise<SyntheticWriterSnapshot> {
  const value = await Effect.runPromise(guard.snapshot());
  assert.equal(value.scope, "synthetic-self-reported");
  assert.ok(value.source !== "active" || value.destination !== "active");
  return value;
}

async function reject(
  operation: Effect.Effect<SyntheticWriterSnapshot, SyntheticWriterFailure>,
  code: SyntheticWriterFailure["code"],
): Promise<void> {
  const result = await Effect.runPromise(Effect.result(operation));
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.code, code);
  const publicFailure = result.failure.toJSON();
  assert.ok(publicFailure !== null && typeof publicFailure === "object");
  assert.deepEqual(Object.keys(publicFailure).sort(), ["_tag", "code"]);
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    groups.push({ name, passed: true });
    process.stdout.write(`pass ${name}\n`);
  } catch {
    // A service defect or assertion can contain paths or input. Reports keep only fixed labels.
    groups.push({ name, passed: false });
    process.stdout.write(`FAIL ${name}\n`);
  }
}

try {
  if (process.argv.length !== 2) throw new Error("no-inputs-accepted");

  await check("initial-state-and-unverified-cutover", async () => {
    const guard = await create();
    const initial = await snapshot(guard);
    assert.equal(initial.epoch, 1);
    assert.equal(initial.phase, "source-active");
    await reject(guard.activateDestination(initial.epoch), "inventory-incomplete");
    await reject(guard.complete(initial.epoch), "inventory-incomplete");
    await reject(guard.resumeSource(initial.epoch), "invalid-transition");
    assert.deepEqual(await snapshot(guard), initial);
  });

  await check("incomplete-evidence-and-secrets-block-activation-and-completion", async () => {
    const cases: Array<{ evidence: SyntheticWriterEvidence; code: SyntheticWriterFailure["code"] }> = [
      { evidence: { ...ready, inventoryComplete: false }, code: "inventory-incomplete" },
      { evidence: { ...ready, snapshotVerified: false }, code: "snapshot-unverified" },
      { evidence: { ...ready, restoreVerified: false }, code: "restore-unverified" },
      { evidence: { ...ready, rehearsalOffline: false }, code: "offline-rehearsal-required" },
      { evidence: { ...ready, backupVerified: false }, code: "backup-unverified" },
      { evidence: { ...ready, secrets: "reauth-required" }, code: "secrets-reauth-required" },
      { evidence: { ...ready, secrets: "unavailable" }, code: "secrets-unavailable" },
    ];
    for (const entry of cases) {
      const guard = await create();
      const rehearsed = await Effect.runPromise(guard.recordRehearsal(1, entry.evidence));
      await reject(guard.fenceSource(rehearsed.epoch), entry.code);
      await reject(guard.activateDestination(rehearsed.epoch), entry.code);
      await reject(guard.complete(rehearsed.epoch), entry.code);
      assert.deepEqual(await snapshot(guard), rehearsed);
      await Effect.runPromise(guard.close());
      await Effect.runPromise(guard.reopen());
      assert.deepEqual(await snapshot(guard), rehearsed);
      await reject(guard.complete(rehearsed.epoch), entry.code);
    }
  });

  await check("competing-cutovers-share-one-durable-epoch", async () => {
    const guard = await create();
    const rehearsed = await Effect.runPromise(guard.recordRehearsal(1, ready));
    const peer = await Effect.runPromise(guard.openPeer());
    handles.push(peer);
    // Both callers submit the same fencing epoch without waiting for the other caller. SQLite
    // serializes their transactions; exactly one may change the shared ledger.
    const attempts = await Promise.all([
      Effect.runPromise(Effect.result(guard.fenceSource(rehearsed.epoch))),
      Effect.runPromise(Effect.result(peer.fenceSource(rehearsed.epoch))),
    ]);
    assert.equal(attempts.filter(Result.isSuccess).length, 1);
    assert.equal(attempts.filter(Result.isFailure).length, 1);
    for (const attempt of attempts) {
      if (Result.isFailure(attempt)) assert.equal(attempt.failure.code, "stale-epoch");
    }
    const fenced = await snapshot(peer);
    assert.equal(fenced.source, "fenced");
    assert.equal(fenced.destination, "offline");
    assert.equal(fenced.epoch, rehearsed.epoch + 1);
    await reject(guard.fenceSource(rehearsed.epoch), "stale-epoch");
    await reject(peer.activateDestination(rehearsed.epoch), "stale-epoch");
    await Effect.runPromise(guard.close());
    await Effect.runPromise(peer.close());
    await Effect.runPromise(guard.reopen());
    assert.deepEqual(await snapshot(guard), fenced);
    const active = await Effect.runPromise(guard.activateDestination(fenced.epoch));
    assert.equal(active.source, "fenced");
    assert.equal(active.destination, "active");
    await reject(guard.activateDestination(fenced.epoch), "stale-epoch");
    await reject(guard.resumeSource(active.epoch), "invalid-transition");
    assert.deepEqual(await snapshot(guard), active);
    const complete = await Effect.runPromise(guard.complete(active.epoch));
    assert.equal(complete.phase, "complete");
    assert.equal(complete.scope, "synthetic-self-reported");
  });

  await check("rollback-fences-destination-before-source-resume", async () => {
    const guard = await create();
    let state = await Effect.runPromise(guard.recordRehearsal(1, ready));
    state = await Effect.runPromise(guard.fenceSource(state.epoch));
    state = await Effect.runPromise(guard.activateDestination(state.epoch));
    await reject(guard.resumeSource(state.epoch), "invalid-transition");
    state = await Effect.runPromise(guard.fenceDestination(state.epoch));
    assert.equal(state.source, "fenced");
    assert.equal(state.destination, "fenced");
    await Effect.runPromise(guard.close());
    await Effect.runPromise(guard.reopen());
    assert.deepEqual(await snapshot(guard), state);
    state = await Effect.runPromise(guard.resumeSource(state.epoch));
    assert.equal(state.source, "active");
    assert.equal(state.destination, "fenced");
    await reject(guard.activateDestination(state.epoch), "invalid-transition");
  });

  await check("new-destination-work-needs-verified-current-capture", async () => {
    const guard = await create();
    let state = await Effect.runPromise(guard.recordRehearsal(1, ready));
    state = await Effect.runPromise(guard.fenceSource(state.epoch));
    state = await Effect.runPromise(guard.activateDestination(state.epoch));
    state = await Effect.runPromise(guard.complete(state.epoch));
    state = await Effect.runPromise(guard.recordDestinationWork(state.epoch));
    state = await Effect.runPromise(guard.recordDestinationWork(state.epoch));
    assert.equal(state.destinationWorkGeneration, 2);
    await reject(guard.recordRollbackCapture(state.epoch, 2, true), "invalid-transition");
    state = await Effect.runPromise(guard.fenceDestination(state.epoch));
    await reject(guard.resumeSource(state.epoch), "rollback-capture-required");
    await reject(guard.recordRollbackCapture(state.epoch, 2, false), "rollback-capture-unverified");
    await reject(guard.recordRollbackCapture(state.epoch, 1, true), "rollback-capture-unverified");
    assert.deepEqual(await snapshot(guard), state);
    await Effect.runPromise(guard.close());
    await Effect.runPromise(guard.reopen());
    await reject(guard.resumeSource(state.epoch), "rollback-capture-required");
    const captured = await Effect.runPromise(guard.recordRollbackCapture(state.epoch, 2, true));
    await reject(guard.resumeSource(state.epoch), "stale-epoch");
    const resumed = await Effect.runPromise(guard.resumeSource(captured.epoch));
    assert.equal(resumed.capturedWorkGeneration, resumed.destinationWorkGeneration);
    assert.equal(resumed.source, "active");
    assert.equal(resumed.destination, "fenced");
    await reject(guard.recordDestinationWork(resumed.epoch), "invalid-transition");
  });

  await check("cancel-before-activation-and-restart-do-not-reset-fences", async () => {
    const guard = await create();
    let state = await Effect.runPromise(guard.recordRehearsal(1, ready));
    state = await Effect.runPromise(guard.fenceSource(state.epoch));
    await reject(guard.resumeSource(state.epoch), "invalid-transition");
    state = await Effect.runPromise(guard.fenceDestination(state.epoch));
    state = await Effect.runPromise(guard.resumeSource(state.epoch));
    state = await Effect.runPromise(guard.recordRehearsal(state.epoch, ready));
    await reject(guard.fenceSource(0), "stale-epoch");
    await reject(guard.fenceSource(Number.NaN), "stale-epoch");
    await Effect.runPromise(guard.close());
    await reject(guard.fenceSource(state.epoch), "ledger-closed");
    await Effect.runPromise(guard.reopen());
    assert.deepEqual(await snapshot(guard), state);
  });
} catch {
  groups.push({ name: "harness-input-or-setup", passed: false });
} finally {
  for (const handle of handles) {
    const closed = await Effect.runPromise(Effect.result(handle.close()));
    if (Result.isFailure(closed)) groups.push({ name: "fixture-close", passed: false });
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(root, "report.json"),
    `${JSON.stringify(
      {
        scope: "synthetic-self-reported",
        productionFencing: false,
        realSourceStopProven: false,
        realCredentialsVerified: false,
        fullMigrationComplete: false,
        passed: groups.length === 6 && groups.every((group) => group.passed),
        groups,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}
if (groups.length !== 6 || groups.some((group) => !group.passed)) process.exitCode = 1;
