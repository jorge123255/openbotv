import type {
  WorkflowGraph,
  WorkflowNodeKind,
  WorkflowOutputTarget,
  WorkflowTriggerType,
} from "@openbot/contracts/ipc";
import type { AppTextKey, AppTranslate } from "@openbot/i18n";

export type WorkflowStarterKind = "approval" | "agent";

export interface WorkflowStarter {
  kind: WorkflowStarterKind;
  title: AppTextKey;
  description: AppTextKey;
  kinds: readonly WorkflowNodeKind[];
}

const STARTERS: readonly WorkflowStarter[] = [
  {
    kind: "approval",
    title: "workflow.starter.approval.title",
    description: "workflow.starter.approval.description",
    kinds: ["trigger", "prompt", "approval", "output", "note"],
  },
  {
    kind: "agent",
    title: "workflow.starter.agent.title",
    description: "workflow.starter.agent.description",
    kinds: ["trigger", "agent", "condition", "approval", "output", "note"],
  },
];

interface StarterFeatures {
  kinds: readonly WorkflowNodeKind[];
  triggers: readonly WorkflowTriggerType[];
  outputs: readonly WorkflowOutputTarget[];
}

/** Starters never arm a schedule, create a webhook, or choose an external output. */
export function workflowStarters(features: StarterFeatures): readonly WorkflowStarter[] {
  return features.triggers.includes("manual") && features.outputs.includes("notify")
    ? STARTERS.filter((starter) => starter.kinds.every((kind) => features.kinds.includes(kind)))
    : [];
}

/** A new editable graph. The agent stays unset until the user chooses it. */
export function workflowStarterGraph(kind: WorkflowStarterKind, t: AppTranslate): WorkflowGraph {
  const agent = kind === "agent";
  const graph: WorkflowGraph = {
    nodes: [
      { id: "start", kind: "trigger", at: { x: 0, y: 0 }, fields: { trigger: "manual" } },
      agent
        ? {
            id: "draft",
            kind: "agent",
            at: { x: 400, y: 0 },
            fields: { agentId: "", task: "Write a short greeting for the user. Return text only." },
          }
        : {
            id: "draft",
            kind: "prompt",
            at: { x: 0, y: 240 },
            fields: { text: t("workflow.starter.approval.sample") },
          },
      ...(agent
        ? [
            {
              id: "decision",
              kind: "condition" as const,
              at: { x: 800, y: 0 },
              fields: { rule: "Does the input contain a greeting?" },
            },
          ]
        : []),
      {
        id: "review",
        kind: "approval",
        at: { x: agent ? 1200 : 400, y: 0 },
        fields: { question: t("workflow.starter.question") },
      },
      { id: "result", kind: "output", at: { x: agent ? 1600 : 800, y: 0 }, fields: { target: "notify" } },
      {
        id: "guide",
        kind: "note",
        at: { x: 400, y: 400 },
        size: { width: 480, height: 400 },
        fields: { text: t(agent ? "workflow.starter.agent.guide" : "workflow.starter.approval.guide"), tone: "yellow" },
      },
    ],
    edges: [
      { id: "start-next", from: "start", to: agent ? "draft" : "review", type: "text" },
      { id: "draft-next", from: "draft", to: agent ? "decision" : "review", type: "text" },
      ...(agent
        ? [{ id: "decision-yes", from: "decision", to: "review", type: "text" as const, branch: "yes" as const }]
        : []),
      { id: "review-result", from: "review", to: "result", type: "text" },
    ],
    strokes: [],
  };
  // Undo keeps removed nodes mounted. A second starter must use new identities.
  const prefix = crypto.randomUUID();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, id: `${prefix}-${node.id}` })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      id: `${prefix}-${edge.id}`,
      from: `${prefix}-${edge.from}`,
      to: `${prefix}-${edge.to}`,
    })),
  };
}
