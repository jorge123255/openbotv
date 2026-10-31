// Runs the canvas starter graphs through the real workflow service and a temporary SQLite profile.
// Provider and mailbox boundaries are controlled; no real agent, account, or network is used.
// Run: bun scripts/workflow-starters-e2e.ts
// Writes .openbot-build/workflow-starters-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkflowGraph, WorkflowRunDetail, WorkflowStep } from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { Effect } from "effect";
import { workflowStarterGraph, workflowStarters } from "../packages/ui/src/features/workflows/workflow-starters";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { WorkflowRunStore } from "../src/backend/workflows/workflow-run-store";
import { WorkflowStore } from "../src/backend/workflows/workflow-store";
import { createWorkflows, type WorkflowsHandle } from "../src/backend/workflows/workflows";

const out = resolve(import.meta.dirname, "../.openbot-build/workflow-starters-e2e");
const directory = await mkdtemp(join(tmpdir(), "openbot-workflow-starters-"));
let database = new OpenBotDatabase(directory);
let service: WorkflowsHandle | undefined;
const checks: string[] = [];
const outputs: string[] = [];
let branch = "yes";
let deliveryState: "running" | "completed" = "completed";
let stoppedDeliveries = 0;
let failure: string | undefined;
const t = translateFor("en");
const check = (name: string, ok: boolean) => {
  assert.ok(ok, name);
  checks.push(name);
};

async function open() {
  await Effect.runPromise(database.initialize());
  const workflows = await Effect.runPromise(
    createWorkflows({
      store: new WorkflowStore({ database }),
      runs: new WorkflowRunStore({ database }),
      delivery: () => ({ status: deliveryState, turnId: "test-turn", error: null }),
      turnAnswer: () => "Hello from the test agent.",
      sendHandoff: () => Effect.sync(() => crypto.randomUUID()),
      stopDelivery: () =>
        Effect.sync(() => {
          stoppedDeliveries += 1;
        }),
      generateText: () =>
        branch === "error" ? Effect.fail({ message: "Test model unavailable" }) : Effect.succeed(branch),
      notify: (notice) => {
        if (notice.kind === "output") outputs.push(notice.text);
      },
      connectionOn: () => false,
      post: () => Effect.die(new Error("A starter must not post to a channel.")),
      changed: () => {},
      rearm: () => {},
      timezone: () => "UTC",
    }),
  );
  service = workflows;
  return workflows;
}

async function close() {
  if (service) await Effect.runPromise(service.close());
  service = undefined;
  database.close();
}

async function until(workflows: WorkflowsHandle, runId: string, ready: (detail: WorkflowRunDetail) => boolean) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    await Effect.runPromise(workflows.sweep());
    const detail = await runCauseEffect(workflows.run(runId));
    if (ready(detail)) return detail;
    assert.ok(Date.now() < deadline, `Run did not reach the expected state: ${JSON.stringify(detail)}`);
    await new Promise((done) => setImmediate(done));
  }
}

async function create(workflows: WorkflowsHandle, graph: WorkflowGraph) {
  const detail = await runCauseEffect(workflows.create({ title: "Starter E2E", graph }));
  return detail.summary.id;
}
const start = async (workflows: WorkflowsHandle, workflowId: string, fromNodeId?: string) =>
  (
    await runCauseEffect(
      workflows.startRun({ workflowId, requestId: crypto.randomUUID(), ...(fromNodeId ? { fromNodeId } : {}) }),
    )
  ).run.id;

try {
  let workflows = await open();
  const approvalGraph = workflowStarterGraph("approval", t);
  const approvalId = await create(workflows, approvalGraph);
  const before = await runCauseEffect(workflows.get(approvalId));
  const capabilities = {
    kinds: approvalGraph.nodes.map((node) => node.kind),
    triggers: ["manual" as const],
    outputs: ["notify" as const],
    uploads: false,
    presence: false,
  };
  check(
    "a host offers only the starter whose node kinds it supports",
    workflowStarters(capabilities)
      .map((item) => item.kind)
      .join() === "approval",
  );
  check(
    "a host without local notifications offers no starters",
    workflowStarters({ ...capabilities, outputs: [] }).length === 0,
  );
  check(
    "a host without manual triggers offers no starters",
    workflowStarters({ ...capabilities, triggers: [] }).length === 0,
  );

  let runId = await start(workflows, approvalId, approvalGraph.nodes.find((node) => node.kind === "trigger")?.id);
  let detail = await until(workflows, runId, (next) => next.run.status === "approval");
  let review = detail.steps.find((step) => step.status === "approval");
  assert.ok(review);
  check("the approval starter waits without an output", outputs.length === 0);
  await runCauseEffect(workflows.decide({ stepId: review.id, approved: true }));
  detail = await until(workflows, runId, (next) => next.run.status === "done");
  check(
    "approval delivers the sample text exactly once",
    outputs.length === 1 && outputs[0] === t("workflow.starter.approval.sample"),
  );
  check(
    "run history contains every executable node and omits the guide",
    detail.steps.length === 4 && detail.steps.every((step) => step.status === "done"),
  );

  runId = await start(workflows, approvalId);
  detail = await until(workflows, runId, (next) => next.run.status === "approval");
  review = detail.steps.find((step) => step.status === "approval");
  assert.ok(review);
  await runCauseEffect(workflows.decide({ stepId: review.id, approved: false }));
  detail = await until(workflows, runId, (next) => next.run.status === "stopped");
  check("reject stops the flow without another output", outputs.length === 1 && detail.run.status === "stopped");

  runId = await start(workflows, approvalId);
  await until(workflows, runId, (next) => next.run.status === "approval");
  await runCauseEffect(workflows.stopRun(runId));
  detail = await until(workflows, runId, (next) => next.run.status === "stopped");
  check(
    "Stop run cancels a waiting approval without output",
    outputs.length === 1 && detail.steps.every((step) => step.status !== "approval"),
  );

  const agentGraph = workflowStarterGraph("agent", t);
  const agentId = await create(workflows, agentGraph);
  const kindOf = (step: WorkflowStep) => agentGraph.nodes.find((node) => node.id === step.nodeId)?.kind;
  runId = await start(workflows, agentId);
  detail = await until(workflows, runId, (next) => next.run.status === "failed");
  check(
    "the unset agent fails visibly instead of using another agent",
    detail.steps.some((step) => kindOf(step) === "agent" && step.status === "failed" && !!step.error) &&
      outputs.length === 1,
  );

  // A stand-in mailbox answers only after the user chooses an agent in the saved graph.
  const chosen = await runCauseEffect(workflows.get(agentId));
  for (const node of chosen.graph.nodes) if (node.kind === "agent") node.fields.agentId = "test-agent";
  const saved = await runCauseEffect(
    workflows.saveGraph({ workflowId: agentId, baseRevision: chosen.revision, graph: chosen.graph }),
  );
  assert.ok(saved.ok);
  runId = await start(workflows, agentId);
  detail = await until(workflows, runId, (next) => next.run.status === "approval");
  review = detail.steps.find((step) => step.status === "approval");
  assert.ok(review);
  check(
    "Yes follows the connected approval branch with the agent text",
    detail.steps.some((step) => kindOf(step) === "condition" && step.branch === "yes") && outputs.length === 1,
  );
  await runCauseEffect(workflows.decide({ stepId: review.id, approved: true }));
  await until(workflows, runId, (next) => next.run.status === "done");
  check(
    "the agent text reaches the local output after approval",
    outputs.length === 2 && outputs[1] === "Hello from the test agent.",
  );

  branch = "no";
  runId = await start(workflows, agentId);
  detail = await until(workflows, runId, (next) => next.run.status === "done");
  check(
    "No skips approval and output",
    detail.steps
      .filter((step) => kindOf(step) === "approval" || kindOf(step) === "output")
      .every((step) => step.status === "skipped") && outputs.length === 2,
  );

  branch = "unclear";
  runId = await start(workflows, agentId);
  detail = await until(workflows, runId, (next) => next.run.status === "failed");
  check(
    "an invalid decision fails with an error and no output",
    detail.steps.some((step) => kindOf(step) === "condition" && step.status === "failed" && !!step.error) &&
      outputs.length === 2,
  );
  branch = "error";
  runId = await start(workflows, agentId);
  detail = await until(workflows, runId, (next) => next.run.status === "failed");
  check(
    "a model failure stays visible in execution history",
    detail.steps.some((step) => step.error === "Test model unavailable") && outputs.length === 2,
  );

  deliveryState = "running";
  runId = await start(workflows, agentId);
  await until(workflows, runId, (next) =>
    next.steps.some((step) => kindOf(step) === "agent" && step.status === "running"),
  );
  await runCauseEffect(workflows.stopRun(runId));
  await until(workflows, runId, (next) => next.run.status === "stopped");
  check("Stop run cancels an active agent delivery", stoppedDeliveries > 0 && outputs.length === 2);
  check(
    "creating another starter preserves the existing graph and revision",
    (await runCauseEffect(workflows.get(approvalId))).revision === before.revision &&
      JSON.stringify((await runCauseEffect(workflows.get(approvalId))).graph) === JSON.stringify(before.graph),
  );
  check(
    "a second starter has independent node identities",
    workflowStarterGraph("approval", t).nodes.every(
      (node) => !approvalGraph.nodes.some((first) => first.id === node.id),
    ),
  );

  await close();
  database = new OpenBotDatabase(directory);
  workflows = await open();
  check(
    "restart preserves the original starter graph",
    JSON.stringify((await runCauseEffect(workflows.get(approvalId))).graph) === JSON.stringify(approvalGraph),
  );
  check("restart preserves stopped run history", (await runCauseEffect(workflows.run(runId))).run.status === "stopped");
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await close();
  await rm(directory, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "report.json"),
    `${JSON.stringify({ passed: !failure, checks, outputs, failure }, null, 2)}\n`,
  );
  process.stdout.write(`${failure ? "FAILED" : "passed"}: ${checks.length} checks; ${out}/report.json\n`);
  if (failure) process.stderr.write(`${failure}\n`);
  process.exitCode = failure ? 1 : 0;
}
