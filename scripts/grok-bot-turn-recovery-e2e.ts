// A Grok Bot turn can sit on a thread other than the one restart recovery names.
// The delivery then becomes interrupted and the turn row stays running, so the chat stays on thinking.
// bun scripts/grok-bot-turn-recovery-e2e.ts
// Writes .openbot-build/grok-bot-turn-recovery-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/grok-bot-turn-recovery-e2e");
const TURN = "e3e4d853-eacb-4271-889f-3c69291ad621";
const PUBLIC_THREAD = "openbot-thread-agent-grok";
const SAND_THREAD = "sand-agent-session";

const report = { passed: false, mismatchedThreadClosed: false, sameThreadClosed: false };

const root = await mkdtemp(join(tmpdir(), "openbot-grok-bot-recovery-"));
const database = new OpenBotDatabase(root);
await Effect.runPromise(database.initialize());

const agent: AgentSummary = {
  id: "agent-grok",
  name: "Grok Bot",
  title: "Grok Bot",
  description: "",
  notifications: true,
  provider: "grok-bot",
  model: "default",
  reasoningEffort: "medium",
  threadId: PUBLIC_THREAD,
  workspacePath: join(root, "workspace"),
  preview: "",
  updatedAt: "2026-10-30T23:28:18.610Z",
  avatarSeed: "agent-grok",
  avatarHue: null,
  avatarUrl: null,
};

function turnStatus(turnId: string): { status: string; completedAt: string | null } | null {
  const row = database.connection
    .prepare("SELECT status, completed_at FROM projection_turns WHERE turn_id = ?")
    .get(turnId);
  if (!isDynamicRecord(row) || !isString(row.status)) return null;
  return { status: row.status, completedAt: isString(row.completed_at) ? row.completed_at : null };
}

try {
  database.replaceAgents("seed-grok-bot", [agent], "agents.imported");
  database.connection
    .prepare(
      `INSERT INTO projection_threads
         (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
       VALUES (?, ?, ?, NULL, ?, ?, 0)`,
    )
    .run(SAND_THREAD, agent.id, "Sand", agent.updatedAt, agent.updatedAt);

  const userMessage = {
    id: "user-hi",
    author: "user" as const,
    text: "hi",
    createdAt: "2026-10-30T23:28:18.610Z",
    status: "completed" as const,
  };
  const running: ConversationSnapshot = {
    agentId: agent.id,
    threadId: PUBLIC_THREAD,
    activeTurnId: TURN,
    revision: 0,
    messages: [userMessage],
  };
  database.persistConversation(running, "turn.started", { turnId: TURN });
  database.connection.prepare("UPDATE projection_turns SET thread_id = ? WHERE turn_id = ?").run(SAND_THREAD, TURN);
  assert.equal(turnStatus(TURN)?.status, "running");

  database.persistConversationChanges({
    agentId: agent.id,
    threadId: PUBLIC_THREAD,
    activeTurnId: null,
    changedMessages: [],
    eventType: "turn.reconciled-after-restart",
    detail: { turnId: TURN, status: "interrupted" },
  });
  const closed = turnStatus(TURN);
  report.mismatchedThreadClosed = closed?.status === "interrupted" && closed.completedAt !== null;
  assert.equal(report.mismatchedThreadClosed, true);

  const second = "turn-same-thread";
  database.persistConversation(
    { ...running, activeTurnId: second, messages: [{ ...userMessage, id: "user-again" }] },
    "turn.started",
    { turnId: second },
  );
  database.persistConversationChanges({
    agentId: agent.id,
    threadId: PUBLIC_THREAD,
    activeTurnId: null,
    changedMessages: [],
    eventType: "turn.interrupted-by-restart",
    detail: { turnId: second },
  });
  const same = turnStatus(second);
  report.sameThreadClosed = same?.status === "interrupted" && same.completedAt !== null;
  assert.equal(report.sameThreadClosed, true);
  report.passed = true;
} finally {
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exit(1);
