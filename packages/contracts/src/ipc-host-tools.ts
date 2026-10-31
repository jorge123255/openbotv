import { isDynamicRecord, isOneOf, isString } from "./runtime-values";

const HOST_TOOL_ASK_ACTIONS = [
  "shell",
  "screenshot",
  "read-file",
  "list-directory",
  "write-file",
  "send-input",
  "mcp",
] as const;

const HOST_TOOL_DECISIONS = ["allow-once", "always", "never"] as const;

export type HostToolAskAction = (typeof HOST_TOOL_ASK_ACTIONS)[number];
export type HostToolDecision = (typeof HOST_TOOL_DECISIONS)[number];

/** One host-tool approval. It carries no gateway token and no access token. */
export interface HostToolAsk {
  readonly requestId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly action: HostToolAskAction;
  readonly detail: string;
}

/** The answer from the approval card. `accept` is a command-approval word and is not valid here. */
export interface HostToolAnswer {
  readonly requestId: string;
  readonly decision: HostToolDecision;
}

export function decodeHostToolAnswer(value: unknown): HostToolAnswer | null {
  if (!isDynamicRecord(value)) return null;
  if ("gatewayToken" in value || "accessToken" in value) return null;
  if (!isString(value.requestId) || value.requestId.length === 0) return null;
  if (!isOneOf(HOST_TOOL_DECISIONS, value.decision)) return null;
  return { requestId: value.requestId, decision: value.decision };
}

export function decodeHostToolAsk(value: unknown): HostToolAsk | null {
  if (!isDynamicRecord(value)) return null;
  if ("gatewayToken" in value || "accessToken" in value) return null;
  if (!isString(value.requestId) || value.requestId.length === 0) return null;
  if (!isString(value.agentId) || !isString(value.threadId) || !isString(value.turnId)) return null;
  if (!isString(value.detail)) return null;
  if (!isOneOf(HOST_TOOL_ASK_ACTIONS, value.action)) return null;
  return {
    requestId: value.requestId,
    agentId: value.agentId,
    threadId: value.threadId,
    turnId: value.turnId,
    action: value.action,
    detail: value.detail,
  };
}
