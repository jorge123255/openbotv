// Real service and SQLite journal against generated facade data. No application or secrets load.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { cp, link, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentSummary, AttachmentSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import {
  MIGRATION_PREPARATION_BLOCKERS,
  type MigrationPreparationInventory,
} from "@openbot/contracts/ipc-migration-preparation";
import { Deferred, Effect, Result } from "effect";
import { AgentRoutineStore } from "../src/backend/agent-routine-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { MigrationPreparationFailure, MigrationPreparationService } from "../src/main/migration-preparation";
import { readMigrationPreparationInventory } from "../src/main/migration-preparation-inventory";
import { MIGRATION_PREPARATION_JOURNAL } from "../src/main/migration-preparation-store";

const root = resolve(import.meta.dirname, "../.openbot-build/migration-preparation-e2e");
const groups: Array<{ name: string; passed: boolean }> = [];
const now = "2026-01-01T12:00:00.000Z";
const CHILD = "--first-save-child";
const PUBLICATION_PHASES = [
  "before-link",
  "after-link",
  "after-unlink",
  "initialization-failure",
  "directory-sync-failure",
  "after-link-sync-failure",
  "during-update",
] as const;
type PublicationPhase = (typeof PUBLICATION_PHASES)[number];
let base = "";
let database: OpenBotDatabase | null = null;
let inventoryReads = 0;

function closeFixtureDatabase(): void {
  database?.close();
  database = null;
}

async function hash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function check(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
    groups.push({ name, passed: true });
  } catch {
    groups.push({ name, passed: false });
  }
  process.stdout.write(`${groups.at(-1)?.passed ? "pass" : "FAIL"} ${name}\n`);
}
async function refused<A>(
  operation: Effect.Effect<A, MigrationPreparationFailure>,
  code: MigrationPreparationFailure["code"],
) {
  const result = await Effect.runPromise(Effect.result(operation));
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.code, code);
  const publicError = result.failure.toJSON();
  assert.ok(publicError !== null && typeof publicError === "object");
  assert.deepEqual(Object.keys(publicError).sort(), ["_tag", "code"]);
}
const readInventory = () =>
  readMigrationPreparationInventory(() => {
    inventoryReads++;
    if (!database) throw new Error("fixture database unavailable");
    return database.connection;
  });
const service = (path: string, inventory = readInventory, clock = () => now) =>
  new MigrationPreparationService({ userDataPath: path, readInventory: inventory, now: clock });

async function seed(): Promise<void> {
  const profile = join(base, "profile");
  database = new OpenBotDatabase(profile);
  await Effect.runPromise(database.initialize());
  const agent: AgentSummary = {
    id: "preparation-agent",
    name: "PRIVATE_FIXTURE_AGENT_NAME",
    title: "Synthetic",
    description: "PRIVATE_FIXTURE_DESCRIPTION",
    notifications: false,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: "preparation-thread",
    workspacePath: join(base, "PRIVATE_FIXTURE_WORKSPACE"),
    preview: "",
    updatedAt: now,
    avatarSeed: "preparation-agent",
    avatarHue: null,
    avatarUrl: null,
  };
  database.replaceAgents("preparation-fixture", [agent], "agents.updated");
  const attachmentBytes = "PRIVATE_FIXTURE_ATTACHMENT_CONTENT";
  const attachmentPath = join(base, "PRIVATE_FIXTURE_ATTACHMENT");
  await writeFile(attachmentPath, attachmentBytes, { mode: 0o600 });
  const attachment: AttachmentSummary = {
    id: "preparation-attachment",
    name: "PRIVATE_FIXTURE_ATTACHMENT",
    size: Buffer.byteLength(attachmentBytes),
    kind: "file",
    mimeType: "text/plain",
    previewKind: "text",
    previewUrl: null,
  };
  const snapshot: ConversationSnapshot = {
    agentId: agent.id,
    threadId: agent.threadId,
    activeTurnId: null,
    revision: 0,
    messages: [
      {
        id: "preparation-message",
        author: "user",
        text: "PRIVATE_FIXTURE_MESSAGE",
        createdAt: now,
        status: "completed",
        attachments: [attachment],
      },
    ],
  };
  database.persistConversationAndMailbox(
    snapshot,
    "conversation.saved",
    {},
    {
      messages: [],
      deliveries: [],
      drafts: [],
      pausedAgentIds: [],
      idempotency: {},
      reactions: [],
      generatedAttachments: [
        { ...attachment, path: attachmentPath, sha256: createHash("sha256").update(attachmentBytes).digest("hex") },
      ],
    },
    "mailbox.updated",
  );
  new AgentRoutineStore(database).create(
    {
      agentId: agent.id,
      name: "PRIVATE_FIXTURE_ROUTINE",
      instruction: "Never run",
      active: true,
      timezone: "Etc/UTC",
      schedule: { kind: "daily", time: "13:00" },
    },
    new Date(now),
  );
}

async function runPublicationChild(): Promise<void> {
  const id = process.argv[3] ?? "";
  const phase = PUBLICATION_PHASES.find((value) => value === process.argv[4]);
  if (process.argv.length !== 5 || id.length !== 36 || !/^[a-f0-9-]{36}$/.test(id) || !phase) process.exit(2);
  const profile = join(root, `publication-${id}`);
  if (!fs.lstatSync(profile).isDirectory() || fs.readFileSync(join(profile, "synthetic-fixture"), "utf8") !== id)
    process.exit(2);
  const finalPath = join(profile, MIGRATION_PREPARATION_JOURNAL);
  const checkpoint = () => {
    fs.writeSync(1, "PUBLICATION_CHECKPOINT\n");
    if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) process.exit(3);
  };
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  const originalFsync = fs.fsyncSync;
  const originalExec = DatabaseSync.prototype.exec;
  let directorySyncs = 0;
  fs.linkSync = (source, target) => {
    if (target === finalPath && phase === "before-link") checkpoint();
    originalLink(source, target);
    if (target === finalPath && phase === "after-link") checkpoint();
  };
  fs.unlinkSync = (path) => {
    originalUnlink(path);
    if (
      typeof path === "string" &&
      path.startsWith(`${profile}/.openbot-migration-preparation-publish-`) &&
      path.endsWith("/journal.db") &&
      phase === "after-unlink"
    )
      checkpoint();
  };
  fs.fsyncSync = (handle) => {
    if (fs.fstatSync(handle).isDirectory()) {
      directorySyncs++;
      if (
        (phase === "directory-sync-failure" && directorySyncs === 1) ||
        (phase === "after-link-sync-failure" && directorySyncs === 3)
      )
        throw new Error("synthetic directory sync failure");
    }
    originalFsync(handle);
  };
  DatabaseSync.prototype.exec = function (sql) {
    if (phase === "initialization-failure" && sql.includes("CREATE TABLE migration_preparation_state"))
      throw new Error("synthetic first-save failure");
    if (phase === "during-update" && sql === "COMMIT") checkpoint();
    originalExec.call(this, sql);
  };
  syncBuiltinESMExports();
  const childService = new MigrationPreparationService({
    userDataPath: profile,
    now: () => now,
    readInventory: () => Effect.succeed({ agents: 0, conversations: 0, messages: 0, attachments: 0, routines: 0 }),
  });
  const current = await Effect.runPromise(childService.getState());
  const operation =
    phase === "during-update" && current.plan
      ? childService.cancel({ planId: current.plan.id, expectedRevision: current.revision })
      : childService.prepare({ destinationKind: "docker-host", expectedRevision: 0 });
  const result = await Effect.runPromise(Effect.result(operation));
  fs.writeSync(
    1,
    `${JSON.stringify(Result.isFailure(result) ? { outcome: "refused", code: result.failure.code } : { outcome: "saved" })}\n`,
  );
}

async function publicationProfile(): Promise<string> {
  const id = randomUUID();
  const profile = join(root, `publication-${id}`);
  await mkdir(profile, { mode: 0o700 });
  await writeFile(join(profile, "synthetic-fixture"), id, { mode: 0o600 });
  publicationProfiles.push(profile);
  return profile;
}
const publicationProfiles: string[] = [];

function startPublicationChild(profile: string, phase: PublicationPhase) {
  const id = profile.slice(profile.lastIndexOf("publication-") + "publication-".length);
  const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.filename), CHILD, id, phase], {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  let checkpointResolve: (() => void) | null = null;
  let checkpointReject: (() => void) | null = null;
  const checkpoint = new Promise<void>((resolveReady, rejectReady) => {
    checkpointResolve = resolveReady;
    checkpointReject = () => rejectReady(new Error("synthetic child ended before checkpoint"));
  });
  // A completed-failure child does not use this promise; prevent an unused rejection there.
  void checkpoint.catch(() => undefined);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("error", () => {
      checkpointReject?.();
      resolveExit({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      checkpointReject?.();
      resolveExit({ code, signal });
    });
  });
  child.stdout.on("data", (bytes: Buffer) => {
    output += bytes.toString("utf8");
    if (output.includes("PUBLICATION_CHECKPOINT\n")) checkpointResolve?.();
    if (output.length > 4096) child.kill("SIGKILL");
  });
  child.stderr.on("data", (bytes: Buffer) => {
    errors += bytes.toString("utf8");
    if (errors.length > 4096) child.kill("SIGKILL");
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  void closed.then(() => clearTimeout(deadline));
  return {
    child,
    checkpoint,
    closed,
    output: () => output,
    stop: async () => {
      child.kill("SIGKILL");
      await closed;
    },
  };
}

if (process.argv[2] === CHILD) {
  await runPublicationChild();
  // Child output uses synchronous writes and the service closes each journal handle before return.
  process.exit(0);
}

try {
  assert.equal(process.argv.length, 2);
  await mkdir(root, { recursive: true, mode: 0o700 });
  base = await mkdtemp(join(root, "fixture-"));
  await seed();
  const profile = join(base, "profile");
  const journal = join(profile, MIGRATION_PREPARATION_JOURNAL);
  // SQLite updates shared-memory reader bookkeeping during SELECT. Durable DB/WAL bytes must stay fixed.
  const appFiles = ["openbot.db", "openbot.db-wal"];
  const appBefore = await Promise.all(appFiles.map((name) => hash(join(profile, name))));
  const first = service(profile);
  let preparedId = "";

  await check("constructor-and-missing-state-do-not-write-or-read-inventory", async () => {
    const files = await readdir(profile);
    assert.ok(!files.includes(MIGRATION_PREPARATION_JOURNAL));
    assert.deepEqual(await Effect.runPromise(first.getState()), { revision: 0, plan: null });
    assert.equal(inventoryReads, 0);
    assert.deepEqual(await readdir(profile), files);
  });
  await check("prepare-persists-count-only-blocked-plan", async () => {
    const result = await Effect.runPromise(first.prepare({ destinationKind: "docker-host", expectedRevision: 0 }));
    assert.equal(result.revision, 1);
    assert.ok(result.plan);
    preparedId = result.plan.id;
    assert.deepEqual(result.plan.inventory, {
      agents: 1,
      conversations: 1,
      messages: 1,
      attachments: 1,
      routines: 1,
    });
    assert.deepEqual(result.plan.blockers, [...MIGRATION_PREPARATION_BLOCKERS]);
    assert.deepEqual(result.plan.operations, { export: false, restore: false, activate: false });
    assert.equal(result.plan.observation, "metadata-only");
    assert.equal(result.plan.status, "prepared");
    assert.equal(inventoryReads, 1);
    const bytes = await readFile(journal);
    for (const canary of ["PRIVATE_FIXTURE", base, "preparation-agent", "preparation-thread", "preparation-message"])
      assert.equal(bytes.includes(Buffer.from(canary)), false);
  });
  await check("new-service-reads-same-plan-and-stale-actions-preserve-journal", async () => {
    const reopened = service(profile);
    assert.deepEqual(await Effect.runPromise(reopened.getState()), await Effect.runPromise(first.getState()));
    const before = await hash(journal);
    await refused(reopened.prepare({ destinationKind: "other-server", expectedRevision: 0 }), "revision-conflict");
    await refused(reopened.prepare({ destinationKind: "other-server", expectedRevision: 1 }), "plan-already-prepared");
    await refused(reopened.cancel({ planId: randomUUID(), expectedRevision: 1 }), "plan-mismatch");
    assert.equal(await hash(journal), before);
    assert.equal(inventoryReads, 1);
  });
  await check("cancel-is-durable-and-reprepare-keeps-revision-order", async () => {
    const cancelled = await Effect.runPromise(first.cancel({ planId: preparedId, expectedRevision: 1 }));
    assert.equal(cancelled.revision, 2);
    assert.equal(cancelled.plan?.id, preparedId);
    assert.equal(cancelled.plan?.status, "cancelled");
    assert.deepEqual(await Effect.runPromise(service(profile).getState()), cancelled);
    await refused(first.cancel({ planId: preparedId, expectedRevision: 2 }), "plan-mismatch");
    const next = await Effect.runPromise(first.prepare({ destinationKind: "local-desktop", expectedRevision: 2 }));
    assert.equal(next.revision, 3);
    assert.notEqual(next.plan?.id, preparedId);
  });
  await check("inventory-failure-or-invalid-count-does-not-create-journal", async () => {
    const empty = join(base, "failed-inventory");
    const failed = service(empty, () =>
      Effect.fail(new MigrationPreparationFailure({ code: "inventory-unavailable" })),
    );
    await refused(failed.prepare({ destinationKind: "other-server", expectedRevision: 0 }), "inventory-unavailable");
    const invalidCounts: MigrationPreparationInventory = {
      agents: -1,
      conversations: 0,
      messages: 0,
      attachments: 0,
      routines: 0,
    };
    await refused(
      service(empty, () => Effect.succeed(invalidCounts)).prepare({
        destinationKind: "other-server",
        expectedRevision: 0,
      }),
      "inventory-unavailable",
    );
    assert.ok(!(await readdir(base)).includes("failed-inventory"));
    const failedDefect = service(empty, () => Effect.die("PRIVATE_FIXTURE_DEFECT"));
    await refused(
      failedDefect.prepare({ destinationKind: "other-server", expectedRevision: 0 }),
      "inventory-unavailable",
    );
    const existing = await Effect.runPromise(first.getState());
    assert.ok(existing.plan);
    const cancelled = await Effect.runPromise(
      first.cancel({ planId: existing.plan.id, expectedRevision: existing.revision }),
    );
    const before = await hash(journal);
    await refused(
      service(profile, () => Effect.fail(new MigrationPreparationFailure({ code: "inventory-unavailable" }))).prepare({
        destinationKind: "docker-host",
        expectedRevision: cancelled.revision,
      }),
      "inventory-unavailable",
    );
    assert.equal(await hash(journal), before);
    await Effect.runPromise(first.prepare({ destinationKind: "local-desktop", expectedRevision: cancelled.revision }));
  });
  await check("competing-services-commit-one-plan-at-the-same-revision", async () => {
    const race = join(base, "race");
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let waiting = 0;
    const heldInventory = () =>
      Effect.gen(function* () {
        waiting++;
        if (waiting === 2) yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return yield* readInventory();
      });
    const requests = [service(race, heldInventory), service(race, heldInventory)].map((entry) =>
      Effect.runPromise(Effect.result(entry.prepare({ destinationKind: "docker-host", expectedRevision: 0 }))),
    );
    try {
      await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout(3000)));
      await Effect.runPromise(Deferred.succeed(release, undefined));
      const results = await Promise.all(requests);
      assert.equal(results.filter(Result.isSuccess).length, 1);
      assert.equal(results.filter(Result.isFailure).length, 1);
      for (const result of results)
        if (Result.isFailure(result)) assert.equal(result.failure.code, "revision-conflict");
      assert.equal((await Effect.runPromise(service(race).getState())).revision, 1);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Promise.all(requests);
    }
  });
  await check("cancel-clock-failure-preserves-prior-plan", async () => {
    const current = await Effect.runPromise(first.getState());
    assert.ok(current.plan);
    const before = await hash(journal);
    await refused(
      service(profile, readInventory, () => "2025-01-01T00:00:00.000Z").cancel({
        planId: current.plan.id,
        expectedRevision: current.revision,
      }),
      "invalid-input",
    );
    assert.equal(await hash(journal), before);
  });
  await check("unknown-version-and-extra-state-fields-refuse-without-overwrite", async () => {
    for (const kind of ["version", "extra-field", "enabled-operation"]) {
      const directory = join(base, `unknown-${kind}`);
      await mkdir(directory);
      const path = join(directory, MIGRATION_PREPARATION_JOURNAL);
      await cp(journal, path);
      const db = new DatabaseSync(path);
      try {
        if (kind === "version") db.exec("PRAGMA user_version=99");
        if (kind === "extra-field")
          db.exec(
            "UPDATE migration_preparation_state SET state_json=json_set(state_json,'$.privatePath','must-not-leak')",
          );
        if (kind === "enabled-operation")
          db.exec(
            "UPDATE migration_preparation_state SET state_json=json_set(state_json,'$.plan.operations.activate',json('true'))",
          );
      } finally {
        db.close();
      }
      const before = await hash(path);
      const unknown = service(directory);
      await refused(unknown.getState(), "journal-invalid");
      await refused(unknown.prepare({ destinationKind: "docker-host", expectedRevision: 3 }), "journal-invalid");
      await refused(unknown.cancel({ planId: randomUUID(), expectedRevision: 3 }), "journal-invalid");
      assert.equal(await hash(path), before);
    }
  });
  await check("corrupt-empty-and-wal-format-journals-are-never-reset", async () => {
    for (const kind of ["corrupt", "empty", "wal"]) {
      const directory = join(base, `invalid-${kind}`);
      await mkdir(directory);
      const path = join(directory, MIGRATION_PREPARATION_JOURNAL);
      if (kind === "wal") {
        await cp(journal, path);
        const db = new DatabaseSync(path);
        try {
          db.exec("PRAGMA journal_mode=WAL");
        } finally {
          db.close();
        }
      } else await writeFile(path, kind === "empty" ? "" : "PRIVATE_CORRUPT_BYTES");
      const names = await readdir(directory);
      const before = await hash(path);
      await refused(service(directory).getState(), "journal-invalid");
      assert.equal(await hash(path), before);
      assert.deepEqual(await readdir(directory), names);
    }
  });
  await check("links-and-sidecars-refuse-without-following-or-recovery", async () => {
    for (const kind of ["symlink", "hardlink", "sidecar"]) {
      const directory = join(base, `link-${kind}`);
      await mkdir(directory);
      const path = join(directory, MIGRATION_PREPARATION_JOURNAL);
      if (kind === "symlink") await symlink(journal, path);
      if (kind === "hardlink") await link(journal, path);
      if (kind === "sidecar") {
        await cp(journal, path);
        await writeFile(`${path}-journal`, "PRIVATE_STALE_JOURNAL");
      }
      const before = await hash(journal);
      await refused(service(directory).getState(), "journal-invalid");
      assert.equal(await hash(journal), before);
      if (kind === "hardlink") await rm(path);
    }
  });
  await check("locked-journal-refuses-update-and-closes-owned-handle", async () => {
    const current = await Effect.runPromise(first.getState());
    assert.ok(current.plan);
    const before = await hash(journal);
    const lock = new DatabaseSync(journal);
    try {
      lock.exec("BEGIN IMMEDIATE");
      await refused(
        first.cancel({ planId: current.plan.id, expectedRevision: current.revision }),
        "journal-unavailable",
      );
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    assert.equal(await hash(journal), before);
    assert.deepEqual(await Effect.runPromise(first.getState()), current);
  });
  await check("absent-main-with-regular-or-symlink-sidecar-is-preserved", async () => {
    for (const suffix of ["-wal", "-shm", "-journal"])
      for (const kind of ["regular", "symlink"]) {
        const profile = await publicationProfile();
        const sidecar = join(profile, `${MIGRATION_PREPARATION_JOURNAL}${suffix}`);
        const sentinel = join(profile, "untouched-sentinel");
        await writeFile(sentinel, "synthetic sidecar target");
        if (kind === "symlink") await symlink(sentinel, sidecar);
        else await writeFile(sidecar, "synthetic orphan sidecar");
        const before = await hash(sidecar);
        const names = await readdir(profile);
        const candidate = service(profile);
        await refused(candidate.getState(), "journal-invalid");
        await refused(candidate.prepare({ destinationKind: "docker-host", expectedRevision: 0 }), "journal-invalid");
        assert.equal(await hash(sidecar), before);
        assert.equal(await readFile(sentinel, "utf8"), "synthetic sidecar target");
        if (kind === "symlink") {
          assert.equal(fs.lstatSync(sidecar).isSymbolicLink(), true);
          assert.equal(await readlink(sidecar), sentinel);
        }
        assert.deepEqual(await readdir(profile), names);
      }
  });
  await check("first-save-initialization-and-prepublication-sync-failure-allow-safe-retry", async () => {
    for (const phase of ["initialization-failure", "directory-sync-failure"] as const) {
      const profile = await publicationProfile();
      const run = startPublicationChild(profile, phase);
      try {
        assert.deepEqual(await run.closed, { code: 0, signal: null });
        assert.deepEqual(JSON.parse(run.output()), { outcome: "refused", code: "journal-unavailable" });
        assert.ok(!(await readdir(profile)).includes(MIGRATION_PREPARATION_JOURNAL));
        assert.deepEqual(await Effect.runPromise(service(profile).getState()), { revision: 0, plan: null });
        assert.equal(
          (await Effect.runPromise(service(profile).prepare({ destinationKind: "docker-host", expectedRevision: 0 })))
            .revision,
          1,
        );
      } finally {
        await run.stop();
      }
    }
  });
  await check("kill-before-link-keeps-final-absent-and-retry-safe", async () => {
    const profile = await publicationProfile();
    const run = startPublicationChild(profile, "before-link");
    try {
      await run.checkpoint;
      run.child.kill("SIGKILL");
      assert.equal((await run.closed).signal, "SIGKILL");
      assert.ok(!(await readdir(profile)).includes(MIGRATION_PREPARATION_JOURNAL));
      assert.deepEqual(await Effect.runPromise(service(profile).getState()), { revision: 0, plan: null });
      assert.equal(
        (await Effect.runPromise(service(profile).prepare({ destinationKind: "local-desktop", expectedRevision: 0 })))
          .revision,
        1,
      );
    } finally {
      await run.stop();
    }
  });
  await check("kill-after-link-recovers-only-verified-candidate-with-same-plan-bytes", async () => {
    const profile = await publicationProfile();
    const path = join(profile, MIGRATION_PREPARATION_JOURNAL);
    const run = startPublicationChild(profile, "after-link");
    try {
      await run.checkpoint;
      run.child.kill("SIGKILL");
      assert.equal((await run.closed).signal, "SIGKILL");
      assert.equal(fs.lstatSync(path).nlink, 2);
      const before = await hash(path);
      const state = await Effect.runPromise(service(profile).getState());
      assert.equal(state.revision, 1);
      assert.equal(state.plan?.status, "prepared");
      assert.equal(fs.lstatSync(path).nlink, 1);
      assert.equal(await hash(path), before);
      assert.deepEqual(await Effect.runPromise(service(profile).getState()), state);
      assert.ok(state.plan);
      assert.equal(
        (await Effect.runPromise(service(profile).cancel({ planId: state.plan.id, expectedRevision: 1 }))).revision,
        2,
      );
    } finally {
      await run.stop();
    }
  });
  await check("kill-after-candidate-unlink-leaves-complete-readable-journal", async () => {
    const profile = await publicationProfile();
    const run = startPublicationChild(profile, "after-unlink");
    try {
      await run.checkpoint;
      run.child.kill("SIGKILL");
      assert.equal((await run.closed).signal, "SIGKILL");
      const path = join(profile, MIGRATION_PREPARATION_JOURNAL);
      const before = await hash(path);
      assert.equal(fs.lstatSync(path).nlink, 1);
      const state = await Effect.runPromise(service(profile).getState());
      assert.equal(state.revision, 1);
      assert.equal(state.plan?.status, "prepared");
      assert.equal(await hash(path), before);
    } finally {
      await run.stop();
    }
  });
  await check("competing-process-first-save-never-overwrites-complete-winner", async () => {
    const profile = await publicationProfile();
    const run = startPublicationChild(profile, "before-link");
    try {
      await run.checkpoint;
      const winner = await Effect.runPromise(
        service(profile).prepare({ destinationKind: "other-server", expectedRevision: 0 }),
      );
      const before = await hash(join(profile, MIGRATION_PREPARATION_JOURNAL));
      run.child.stdin.write("x");
      assert.deepEqual(await run.closed, { code: 0, signal: null });
      assert.ok(run.output().includes('"code":"revision-conflict"'));
      assert.equal(await hash(join(profile, MIGRATION_PREPARATION_JOURNAL)), before);
      assert.deepEqual(await Effect.runPromise(service(profile).getState()), winner);
    } finally {
      await run.stop();
    }
  });
  await check("unsafe-publication-markers-links-or-extra-entries-are-not-cleaned", async () => {
    for (const kind of ["marker-symlink", "extra-entry", "bad-marker", "candidate-symlink"] as const) {
      const profile = await publicationProfile();
      const run = startPublicationChild(profile, "after-link");
      try {
        await run.checkpoint;
        await run.stop();
        const name = (await readdir(profile)).find((entry) =>
          entry.startsWith(".openbot-migration-preparation-publish-"),
        );
        assert.ok(name);
        const directory = join(profile, name);
        const marker = join(directory, "publication.json");
        const path = join(profile, MIGRATION_PREPARATION_JOURNAL);
        if (kind === "marker-symlink") {
          const moved = join(profile, "marker-target");
          await cp(marker, moved);
          await rm(marker);
          await symlink(moved, marker);
        }
        if (kind === "extra-entry") await writeFile(join(directory, "unknown-entry"), "must remain");
        if (kind === "bad-marker") await writeFile(marker, "{}");
        if (kind === "candidate-symlink") {
          await rm(join(directory, "journal.db"));
          await link(path, join(profile, "unknown-hardlink"));
          await symlink(path, join(directory, "journal.db"));
        }
        const before = await hash(path);
        const names = await readdir(directory);
        await refused(service(profile).getState(), "journal-invalid");
        assert.equal(await hash(path), before);
        assert.deepEqual(await readdir(directory), names);
        if (kind === "extra-entry")
          assert.equal(await readFile(join(directory, "unknown-entry"), "utf8"), "must remain");
      } finally {
        await run.stop();
      }
    }
  });
  await check("post-link-sync-failure-remains-complete-and-is-not-reset", async () => {
    const profile = await publicationProfile();
    const run = startPublicationChild(profile, "after-link-sync-failure");
    try {
      assert.deepEqual(await run.closed, { code: 0, signal: null });
      assert.deepEqual(JSON.parse(run.output()), { outcome: "refused", code: "journal-unavailable" });
      const path = join(profile, MIGRATION_PREPARATION_JOURNAL);
      const before = await hash(path);
      const state = await Effect.runPromise(service(profile).getState());
      assert.equal(state.revision, 1);
      assert.equal(state.plan?.status, "prepared");
      await refused(
        service(profile).prepare({ destinationKind: "docker-host", expectedRevision: 0 }),
        "revision-conflict",
      );
      assert.equal(await hash(path), before);
    } finally {
      await run.stop();
    }
  });
  await check("mid-update-kill-retains-transaction-sidecar-and-refuses-without-repair", async () => {
    const profile = await publicationProfile();
    await Effect.runPromise(service(profile).prepare({ destinationKind: "docker-host", expectedRevision: 0 }));
    const run = startPublicationChild(profile, "during-update");
    try {
      await run.checkpoint;
      await run.stop();
      const path = join(profile, MIGRATION_PREPARATION_JOURNAL);
      assert.ok((await readdir(profile)).includes(`${MIGRATION_PREPARATION_JOURNAL}-journal`));
      const before = [await hash(path), await hash(`${path}-journal`)];
      await refused(service(profile).getState(), "journal-invalid");
      assert.deepEqual([await hash(path), await hash(`${path}-journal`)], before);
    } finally {
      await run.stop();
    }
  });
  await check("application-data-and-routine-intent-are-unchanged", async () => {
    assert.deepEqual(await Promise.all(appFiles.map((name) => hash(join(profile, name)))), appBefore);
    assert.ok(database);
    assert.equal(database.connection.prepare("SELECT count(*) AS total FROM projection_routine_runs").get()?.total, 0);
    assert.equal(database.connection.prepare("SELECT active FROM projection_agent_routines").get()?.active, 1);
    assert.equal(
      database.connection.prepare("SELECT count(*) AS total FROM projection_thread_messages").get()?.total,
      1,
    );
  });
} catch {
  groups.push({ name: "fixture-setup", passed: false });
} finally {
  closeFixtureDatabase();
  if (base) await rm(base, { recursive: true, force: true });
  for (const profile of publicationProfiles) await rm(profile, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const report = {
    passed: groups.length === 21 && groups.every((group) => group.passed),
    groups,
    realDataRead: false,
    credentialValuesRead: false,
    exportAvailable: false,
    restoreAvailable: false,
    activationAvailable: false,
  };
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}
