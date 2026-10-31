import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import type { GrokBotGatewayEvent } from "./grok-bot-gateway-events";

/** BotAI `SEND_MESSAGE_TOOL_CALL_OUTLINE_NAME`. */
const SEND_MESSAGE_TOOL = "SendMessage";

const RETRY_CLEAR = new Set(["text-delta", "thinking-delta", "tool-call", "send-message", "turn-ended"]);

/**
 * What the sand gateway has said about the agent we are watching.
 * A turn ends on `turn-ended`, or when `running` goes from true to false.
 * A live subagent keeps `running` true. Retrying is not an idle end.
 */
export interface TurnWatch {
  sawRunning: boolean;
  running: boolean | null;
  turnEnded: boolean;
  subagentHold: boolean;
  composing: boolean;
  retrying: boolean;
  ended: boolean;
  usage: GrokBotTurnUsage | null;
  activity: "writing" | "retrying" | null;
  runningFieldSeen: boolean;
}

/** Token counts from a `turn-ended` usage object or `lastRun.usage`. Cache fields are separate. */
export interface GrokBotTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export function createTurnWatch(): TurnWatch {
  return {
    sawRunning: false,
    running: null,
    turnEnded: false,
    subagentHold: false,
    composing: false,
    retrying: false,
    ended: false,
    usage: null,
    activity: null,
    runningFieldSeen: false,
  };
}

export function applyGatewayEvent(watch: TurnWatch, agentId: string, event: GrokBotGatewayEvent): void {
  const payload = isDynamicRecord(event.payload) ? event.payload : null;
  if (event.channel === "agents" && payload && Array.isArray(payload.agents)) {
    for (const row of payload.agents) {
      if (isDynamicRecord(row)) noteAgent(watch, agentId, row);
    }
    return;
  }
  if (event.channel === "agent-upserted" && payload && isDynamicRecord(payload.agent)) {
    noteAgent(watch, agentId, payload.agent);
    return;
  }
  if (event.channel === "subagents") {
    noteSubagents(watch, agentId, event.payload);
    refresh(watch);
    return;
  }
  notePayloadUpdates(watch, agentId, event.payload);
}

/** One `listAgents` body. Rows with no running flag do not change the watch. */
export function applyRosterBody(watch: TurnWatch, agentId: string, body: unknown): void {
  for (const row of rosterRows(body)) noteAgent(watch, agentId, row);
}

export function rosterBodyHasRunningField(body: unknown): boolean {
  return rosterRows(body).some((row) => booleanField(row, "isRunning", "running") !== null);
}

/** A pending SendMessage tool is composing, the same as BotAI `trackComposingFromUpdate`. */
export function noteSendMessagePending(watch: TurnWatch, pending: boolean): void {
  if (!pending || watch.ended || watch.composing) return;
  watch.composing = true;
  refresh(watch);
}

/** Source English for the activity line. An empty string clears Writing… or Retrying…. */
export function grokBotActivityDetail(activity: TurnWatch["activity"]): string {
  if (activity === "writing") return sourceText("status.agent.grokBotWriting");
  if (activity === "retrying") return sourceText("status.agent.grokBotRetrying");
  return "";
}

/**
 * ACP usage counts cache inside `inputTokens`. BotAI reports cache beside the input count,
 * so the notification adds the cache back in.
 */
export function grokBotUsageParams(usage: GrokBotTurnUsage): {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
} {
  return {
    inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cacheReadTokens,
    cachedWriteTokens: usage.cacheWriteTokens,
  };
}

function noteAgent(watch: TurnWatch, agentId: string, row: DynamicRecord): void {
  const id = stringField(row, "id", "agentId");
  if (id !== agentId) return;
  const wasEnded = watch.ended;
  const running = booleanField(row, "isRunning", "running");
  if (running !== null) {
    watch.runningFieldSeen = true;
    watch.running = running;
    if (running) watch.sawRunning = true;
  }
  const composing = booleanField(row, "isComposingMessage", "composing");
  if (composing !== null) watch.composing = composing;
  const retrying = booleanField(row, "isRetrying", "retrying");
  if (retrying !== null) watch.retrying = retrying;
  refresh(watch);
  if (!wasEnded && watch.ended) watch.usage ??= usageFrom(row.lastRun) ?? usageFrom(row);
}

function notePayloadUpdates(watch: TurnWatch, agentId: string, payload: unknown): void {
  if (!isDynamicRecord(payload)) return;
  const owner = stringField(payload, "agentId", "conversationId", "sessionId");
  if (isUpdate(payload)) noteUpdate(watch, agentId, payload, owner);
  if (isDynamicRecord(payload.update)) noteUpdate(watch, agentId, payload.update, owner);
  if (Array.isArray(payload.updates)) {
    for (const update of payload.updates) {
      if (isDynamicRecord(update)) noteUpdate(watch, agentId, update, owner);
    }
  }
}

function noteUpdate(watch: TurnWatch, agentId: string, update: DynamicRecord, ownerId: string | null): void {
  const owner = ownerId ?? stringField(update, "agentId");
  if (owner && owner !== agentId) return;
  const type = typeof update.type === "string" ? update.type : "";
  if (type === "retrying") {
    watch.retrying = true;
    refresh(watch);
    return;
  }
  if (RETRY_CLEAR.has(type)) watch.retrying = false;
  if (type === "tool-call" && update.name === SEND_MESSAGE_TOOL) watch.composing = update.status === "pending";
  else if (type === "send-message" || type === "turn-ended") watch.composing = false;
  if (type === "turn-ended") {
    watch.turnEnded = true;
    watch.usage ??= usageFrom(update);
  }
  refresh(watch);
}

function noteSubagents(watch: TurnWatch, agentId: string, payload: unknown): void {
  if (!isDynamicRecord(payload)) return;
  const parent = stringField(payload, "parentAgentId", "parentId");
  const rows = Array.isArray(payload.subagents)
    ? payload.subagents
    : Array.isArray(payload.agents)
      ? payload.agents
      : [payload];
  let saw = false;
  let hold = false;
  for (const row of rows) {
    if (!isDynamicRecord(row)) continue;
    const rowParent = stringField(row, "parentAgentId", "parentId") ?? parent;
    if (rowParent !== agentId) continue;
    saw = true;
    const status = stringField(row, "status") ?? "";
    if (status === "running" || status === "active" || status === "inProgress" || row.running === true) hold = true;
  }
  if (saw) watch.subagentHold = hold;
}

function refresh(watch: TurnWatch): void {
  if (watch.retrying) {
    watch.activity = "retrying";
    watch.ended = false;
    return;
  }
  watch.activity = watch.composing ? "writing" : null;
  const held = watch.running === true || (watch.subagentHold && watch.running !== false);
  if (watch.turnEnded && !held) {
    watch.ended = true;
    return;
  }
  if (watch.sawRunning && watch.running === false) {
    watch.ended = true;
    return;
  }
  watch.ended = false;
}

function isUpdate(value: DynamicRecord): boolean {
  return (
    value.type === "turn-ended" ||
    value.type === "retrying" ||
    value.type === "tool-call" ||
    value.type === "send-message" ||
    value.type === "text-delta" ||
    value.type === "thinking-delta"
  );
}

function usageFrom(value: unknown): GrokBotTurnUsage | null {
  if (!isDynamicRecord(value)) return null;
  const nested = isDynamicRecord(value.usage)
    ? value.usage
    : isDynamicRecord(value.lastRun) && isDynamicRecord(value.lastRun.usage)
      ? value.lastRun.usage
      : value;
  const input = count(nested.inputTokens) ?? count(nested.input_tokens);
  const output = count(nested.outputTokens) ?? count(nested.output_tokens);
  if (input === null && output === null) return null;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens:
      count(nested.cacheReadTokens) ?? count(nested.cachedReadTokens) ?? count(nested.cache_read_tokens) ?? 0,
    cacheWriteTokens:
      count(nested.cacheWriteTokens) ?? count(nested.cachedWriteTokens) ?? count(nested.cache_write_tokens) ?? 0,
  };
}

function rosterRows(body: unknown): DynamicRecord[] {
  const rows = Array.isArray(body)
    ? body
    : isDynamicRecord(body) && Array.isArray(body.agents)
      ? body.agents
      : isDynamicRecord(body) && body.agent !== undefined
        ? [body.agent]
        : [];
  return rows.filter(isDynamicRecord);
}

function booleanField(record: DynamicRecord, ...names: string[]): boolean | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function stringField(record: DynamicRecord, ...names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
