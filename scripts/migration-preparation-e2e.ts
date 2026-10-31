// Real service and SQLite journal against generated facade data. No application or secrets load.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    assert.deepEqual(result.plan.inventory, { agents: 1, conversations: 1, messages: 1, attachments: 1, routines: 1 });
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
  await mkdir(root, { recursive: true, mode: 0o700 });
  const report = {
    passed: groups.length === 12 && groups.every((group) => group.passed),
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
