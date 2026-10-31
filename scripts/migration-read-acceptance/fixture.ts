// Generated data only. The factory accepts no paths and constructs no application or provider.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AgentSummary,
  type AttachmentSummary,
  type ConversationMessage,
  isAgentSummary,
  isConversationSnapshot,
} from "@openbot/contracts/ipc";
import { Effect, Schema } from "effect";
import { AgentRoutineStore } from "../../src/backend/agent-routine-store";
import type { StoredGeneratedAttachment } from "../../src/backend/attachment-files";
import type { MailboxProjectionState } from "../../src/backend/database/mailbox-projection";
import { OpenBotDatabase } from "../../src/backend/openbot-database";

export const READ_ACCEPTANCE_IDS = Object.freeze({
  agentId: "agent-read-acceptance",
  threadId: "thread-read-acceptance",
  userMessageId: "message-read-user-first",
  assistantMessageId: "message-read-assistant-first",
  lastUserMessageId: "message-read-user-last",
  lastAssistantMessageId: "message-read-assistant-last",
  firstTurnId: "turn-read-first",
  lastTurnId: "turn-read-last",
  attachmentId: "attachment-read-acceptance",
  externalSessionId: "external-read-acceptance",
  resumeCursor: "cursor-read-acceptance",
});

export const READ_ACCEPTANCE_TEXT = Object.freeze({
  user: "Keep the synthetic\ncafé report and its history.",
  assistant: "The synthetic café report is attached.",
  lastUser: "Keep the same agent and conversation identifiers.",
  lastAssistant: "The saved history remains available for read acceptance.",
  attachment: "Synthetic café report. No user data or credentials.\n",
});

const createdAt = "2026-01-01T08:00:00.000Z";

export class ReadAcceptanceFixtureFailure extends Schema.TaggedError<ReadAcceptanceFixtureFailure>()(
  "ReadAcceptanceFixtureFailure",
  { code: Schema.Literal("SYNTHETIC_READ_FIXTURE_FAILED") },
) {}

const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => new ReadAcceptanceFixtureFailure({ code: "SYNTHETIC_READ_FIXTURE_FAILED" }),
  });

function writeRecords(database: OpenBotDatabase, source: string) {
  const ids = READ_ACCEPTANCE_IDS;
  const agent: AgentSummary = {
    id: ids.agentId,
    name: "Read acceptance agent",
    title: "Synthetic history reader",
    description: "Generated fixture. No provider is started.",
    notifications: false,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: ids.threadId,
    workspacePath: join(source, "workspace", ids.agentId),
    preview: READ_ACCEPTANCE_TEXT.lastAssistant,
    updatedAt: createdAt,
    avatarSeed: ids.agentId,
    avatarHue: null,
    avatarUrl: null,
    computerUse: false,
    allowAutomation: false,
    mcpServerIds: [],
  };
  if (!isAgentSummary(agent)) throw new ReadAcceptanceFixtureFailure({ code: "SYNTHETIC_READ_FIXTURE_FAILED" });
  database.replaceAgents("read-acceptance:roster", [agent], "agents.updated");
  const session = database.bindProviderSession({
    threadId: ids.threadId,
    provider: agent.provider,
    externalSessionId: ids.externalSessionId,
    model: agent.model,
    effort: agent.reasoningEffort,
    resumeCursor: ids.resumeCursor,
  });
  const summary: AttachmentSummary = {
    id: ids.attachmentId,
    name: "synthetic-café-report.txt",
    size: Buffer.byteLength(READ_ACCEPTANCE_TEXT.attachment),
    kind: "file",
    mimeType: "text/plain",
    previewKind: "text",
    previewUrl: null,
  };
  const attachment: StoredGeneratedAttachment = {
    ...summary,
    path: join(source, "shared", "Transfers", ids.attachmentId, summary.name),
    sha256: createHash("sha256").update(READ_ACCEPTANCE_TEXT.attachment).digest("hex"),
    ownerAgentId: ids.agentId,
    ownerThreadId: ids.threadId,
  };
  const messages: ConversationMessage[] = [
    {
      id: ids.userMessageId,
      turnId: ids.firstTurnId,
      author: "user",
      text: READ_ACCEPTANCE_TEXT.user,
      createdAt,
      status: "completed",
    },
    {
      id: ids.assistantMessageId,
      turnId: ids.firstTurnId,
      author: "assistant",
      text: READ_ACCEPTANCE_TEXT.assistant,
      createdAt: "2026-01-01T08:00:01.000Z",
      status: "completed",
      attachments: [summary],
    },
    {
      id: ids.lastUserMessageId,
      turnId: ids.lastTurnId,
      author: "user",
      text: READ_ACCEPTANCE_TEXT.lastUser,
      createdAt: "2026-01-01T08:01:00.000Z",
      status: "completed",
    },
    {
      id: ids.lastAssistantMessageId,
      turnId: ids.lastTurnId,
      author: "assistant",
      text: READ_ACCEPTANCE_TEXT.lastAssistant,
      createdAt: "2026-01-01T08:01:01.000Z",
      status: "completed",
    },
  ];
  const snapshot = { agentId: ids.agentId, threadId: ids.threadId, activeTurnId: null, revision: 0, messages };
  if (!isConversationSnapshot(snapshot))
    throw new ReadAcceptanceFixtureFailure({ code: "SYNTHETIC_READ_FIXTURE_FAILED" });
  const mailbox: MailboxProjectionState = {
    messages: [],
    deliveries: [],
    drafts: [],
    generatedAttachments: [attachment],
    pausedAgentIds: [],
    idempotency: {},
    reactions: [],
  };
  database.persistConversationAndMailbox(snapshot, "conversation.saved", {}, mailbox, "mailbox.updated");
  database.deactivateProviderSessions(ids.threadId);
  database.ensureProviderHistoryImport({
    sessionId: session.id,
    threadId: ids.threadId,
    provider: agent.provider,
    externalSessionId: ids.externalSessionId,
  });
  database.markProviderHistoryImportState(session.id, "complete", { cursor: ids.resumeCursor, syntheticOnly: true });
  const routines = new AgentRoutineStore(database);
  const activeRoutine = routines.create(
    {
      agentId: ids.agentId,
      name: "Synthetic active intent",
      instruction: "Never execute in the read fixture.",
      active: true,
      timezone: "Etc/UTC",
      schedule: { kind: "daily", time: "09:00" },
      limitPolicy: "wait",
      missedPolicy: "run-once",
    },
    new Date(createdAt),
  );
  const pausedRoutine = routines.create(
    {
      agentId: ids.agentId,
      name: "Synthetic paused intent",
      instruction: "Keep this routine paused.",
      active: false,
      timezone: "Etc/UTC",
      schedule: { kind: "daily", time: "10:00" },
      limitPolicy: "skip",
      missedPolicy: "skip",
    },
    new Date(createdAt),
  );
  return Object.freeze({
    ...ids,
    providerSessionId: session.id,
    activeRoutineId: activeRoutine.id,
    pausedRoutineId: pausedRoutine.id,
  });
}

/** Creates and closes real facade writes, then copies only the generated recovery tree. */
export const createReadAcceptanceFixture = Effect.fn("ReadAcceptanceFixture.create")(function* () {
  const reportRoot = resolve(import.meta.dirname, "../../.openbot-build/migration-read-acceptance");
  yield* io(() => mkdir(reportRoot, { recursive: true, mode: 0o700 }));
  const base = yield* io(() => mkdtemp(join(reportRoot, "fixture-")));
  const source = join(base, "source");
  const target = join(base, "target");
  const paths = Object.freeze({
    base,
    source,
    target,
    sourceDatabase: join(source, "userdata", "openbot.db"),
    targetDatabase: join(target, "userdata", "openbot.db"),
    attachment: join(source, "shared", "Transfers", READ_ACCEPTANCE_IDS.attachmentId, "synthetic-café-report.txt"),
    targetAttachment: join(
      target,
      "shared",
      "Transfers",
      READ_ACCEPTANCE_IDS.attachmentId,
      "synthetic-café-report.txt",
    ),
  });
  const dispose = io(() => rm(base, { recursive: true, force: true }));
  return yield* Effect.gen(function* () {
    yield* io(() => mkdir(join(source, "workspace", READ_ACCEPTANCE_IDS.agentId), { recursive: true, mode: 0o700 }));
    yield* io(() =>
      mkdir(join(source, "shared", "Transfers", READ_ACCEPTANCE_IDS.attachmentId), { recursive: true, mode: 0o700 }),
    );
    yield* io(() => writeFile(paths.attachment, READ_ACCEPTANCE_TEXT.attachment, { mode: 0o600, flag: "wx" }));
    const database = new OpenBotDatabase(join(source, "userdata"));
    const ids = yield* Effect.acquireUseRelease(
      Effect.succeed(database),
      (db) =>
        Effect.gen(function* () {
          yield* db.initialize();
          return yield* Effect.try({
            try: () => writeRecords(db, source),
            catch: () => new ReadAcceptanceFixtureFailure({ code: "SYNTHETIC_READ_FIXTURE_FAILED" }),
          });
        }),
      (db) => Effect.sync(() => db.close()),
    );
    // The last SQLite connection is closed before the tree is copied. No live WAL copy is used.
    yield* io(() =>
      cp(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true }),
    );
    return Object.freeze({ paths, ids, dispose });
  }).pipe(
    Effect.mapError(() => new ReadAcceptanceFixtureFailure({ code: "SYNTHETIC_READ_FIXTURE_FAILED" })),
    Effect.onError(() => dispose.pipe(Effect.orDie)),
  );
});
