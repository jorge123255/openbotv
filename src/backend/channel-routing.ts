/**
 * Channel routing treats a named MCP or agent-bridge reply as work for a member.
 * The peers in `from` and `to` are not channel members, and not Slack members.
 */

/** A `from` field, as `from=openbot` or `from: "openbot"`. */
const FROM_FIELD = /(?:^|[\s,(])from\s*[:=]\s*"?[A-Za-z0-9][\w.-]*/iu;
/** A `to` field, as `to=grok-tunner` or `to: "grok-tunner"`. */
const TO_FIELD = /(?:^|[\s,(])to\s*[:=]\s*"?[A-Za-z0-9][\w.-]*/iu;
/** The request tells the member to answer on an MCP bridge. */
const BRIDGE_REPLY = /post_message|agent-bridge|agent-mcp|\bvia bridge\b|\bon the bridge\b|\bbridge post\b|\bMCP\b/iu;

/**
 * Whether the request already names the bridge reply: the tool or the bridge, and both peers.
 * A later routing question must not ask the person to choose that reply again.
 */
export function bridgeReplySpecified(text: string): boolean {
  return FROM_FIELD.test(text) && TO_FIELD.test(text) && BRIDGE_REPLY.test(text);
}

/** The question asks the person to invent a send, or to name its recipient. */
const SEND_TARGET_QUESTION = /what should be sent|to whom|which channel member|which member|no member with that name/iu;
/** The question names an MCP tool or a bridge peer as if it were a person. */
const TOOL_PEER_QUESTION = /agent-mcp|agent-bridge|post_message/iu;

/**
 * Whether Coordinator must not pause on this question.
 *
 * The request already names the bridge reply, and the question asks what to send or to whom.
 * Or the question asks which member an MCP or bridge name is, and the request is about that bridge.
 */
export function routingQuestionSuperseded(question: string, instruction: string): boolean {
  if (bridgeReplySpecified(instruction) && SEND_TARGET_QUESTION.test(question)) return true;
  return TOOL_PEER_QUESTION.test(question) && BRIDGE_REPLY.test(instruction);
}

/** One decoded routing answer. Extra fields are already rejected. */
export type RoutingChoice =
  | { readonly agentIds: readonly string[] }
  | { readonly taskId: string }
  | { readonly question: string }
  | { readonly idle: true }
  | { readonly agentId: string };

/**
 * The members a routing answer names, after a superseded bridge question.
 * Null means the answer is still a question, or it is not a member choice.
 * `bridgeLeadId` is set only when the lead can take the work of that question.
 */
export function routingMemberIds(decision: RoutingChoice, bridgeLeadId: string | null): readonly string[] | null {
  if ("question" in decision) return bridgeLeadId === null ? null : [bridgeLeadId];
  if ("agentId" in decision) return [decision.agentId];
  if ("agentIds" in decision) return decision.agentIds;
  return null;
}

/** The lead reads this in the routing prompt. It does not execute the reply. */
export const CHANNEL_ROUTING_BRIDGE_RULE =
  "An MCP server, an MCP tool, and a bridge peer are not channel members. When the request already names an MCP or agent-bridge reply, with from and to, do not return a question about what to send, to whom, or which member that name is. Assign the one member whose role covers the work.";

/** The assigned member reads this in the channel packet. */
export const CHANNEL_ASSIGNMENT_BRIDGE_RULE =
  "When this assignment tells you to reply with an MCP tool such as agent-bridge post_message, and it names from, to, and the text, call that MCP tool in this turn. Do not ask a person what to send or to whom. Do not look up the MCP server or the bridge peer as a channel member, a Slack member, or a teammate.";
