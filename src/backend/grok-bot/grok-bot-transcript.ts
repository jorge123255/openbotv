import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { GrokBotInferenceMessage } from "./grok-bot-inference";

/**
 * One sand tool card from the transcript. OpenBot shows the card. OpenBot does not run the tool.
 *
 * The fields are the ones BotAI reads in `projectTranscriptEntry` for `kind: "tool-call"`:
 * `id`, `name` or `toolName`, `status`, and `summary`.
 */
export interface GrokBotTranscriptToolStep {
  readonly id: string;
  readonly name: string;
  readonly status: "inProgress" | "completed" | "failed";
  readonly detail: string;
}

/** Tool cards and an open permission card after the user row for this prompt. */
export interface GrokBotTranscriptActivity {
  readonly steps: readonly GrokBotTranscriptToolStep[];
  readonly permissionPending: boolean;
}

/**
 * BotAI transcript ids (`transcript-entry-ids.ts`): `t<n>u` is a user message, `t<turn>a<n>` is a
 * private assistant row, and `t<turn>s<n>` is a SendMessage card. The host shows a text
 * `send-message` card to the user. Plain assistant text stays out of the chat. A card with
 * `message.channel` goes to another surface. A `tool-call` card is not assistant text.
 */
export function transcriptToMessages(body: unknown): GrokBotInferenceMessage[] {
  const messages: GrokBotInferenceMessage[] = [];
  for (const entry of transcriptEntries(body)) {
    if (!isDynamicRecord(entry) || entry.kind === "tool-call") continue;
    const sendText = visibleSendMessageText(entry);
    if (sendText !== null) {
      messages.push({ role: "ASSISTANT", text: sendText });
      continue;
    }
    const role = transcriptRole(entry);
    const text = transcriptText(entry);
    if (!role || text.length === 0) continue;
    messages.push({ role, text });
  }
  return messages;
}

/**
 * Read `kind: "tool-call"` cards. A card needs a non-empty `id` and `name` (or `toolName`).
 * `summary` is the detail text. Status `failed` or `error` is failed. `done` or `aborted` is
 * completed. Any other status is in progress. Send-message cards and unknown cards stay out.
 */
export function transcriptToolSteps(body: unknown): readonly GrokBotTranscriptToolStep[] {
  const steps: GrokBotTranscriptToolStep[] = [];
  for (const entry of transcriptEntries(body)) {
    if (!isDynamicRecord(entry)) continue;
    const step = toolStep(entry);
    if (step) steps.push(step);
  }
  return steps;
}

/** Tool cards and an open permission card that follow the user row for this prompt. */
export function transcriptActivityAfterPrompt(body: unknown, prompt: string): GrokBotTranscriptActivity {
  const entries = transcriptEntries(body);
  const start = lastUserPromptIndex(entries, prompt);
  if (start < 0) return { steps: [], permissionPending: false };
  const steps: GrokBotTranscriptToolStep[] = [];
  let permissionPending = false;
  for (const entry of entries.slice(start + 1)) {
    if (!isDynamicRecord(entry)) continue;
    const step = toolStep(entry);
    if (step) steps.push(step);
    if (permissionCardPending(entry)) permissionPending = true;
  }
  return { steps, permissionPending };
}

/** BotAI `quotableEntryText` for a host SendMessage that the chat shows. */
function visibleSendMessageText(entry: DynamicRecord): string | null {
  if (entry.kind !== "send-message" || !isDynamicRecord(entry.message)) return null;
  const message = entry.message;
  if (message.type !== "text" || typeof message.content !== "string") return null;
  if (typeof message.channel === "string" && message.channel.length > 0) return null;
  if (message.content.trim().length === 0) return null;
  return message.content;
}

function transcriptRole(entry: DynamicRecord): "USER" | "ASSISTANT" | null {
  const role = typeof entry.role === "string" ? entry.role : "";
  const kind = typeof entry.kind === "string" ? entry.kind : "";
  if (role === "user" || kind === "user-message" || (kind === "message" && role === "user")) return "USER";
  if (role === "assistant" || kind === "assistant-message" || (kind === "message" && role === "assistant"))
    return "ASSISTANT";
  const id = typeof entry.id === "string" ? entry.id : "";
  if (/^t\d+u$/u.test(id)) return "USER";
  if (/^t\d+a\d+$/u.test(id)) return "ASSISTANT";
  return null;
}

function transcriptEntries(body: unknown): readonly unknown[] {
  if (Array.isArray(body)) return body;
  if (isDynamicRecord(body) && Array.isArray(body.entries)) return body.entries;
  return [];
}

/** A permission ask is resolved when BotAI records one of these `ask.status` values. */
const RESOLVED_PERMISSION = new Set(["always", "never", "denied", "expired", "allow-once"]);

function toolStep(entry: DynamicRecord): GrokBotTranscriptToolStep | null {
  if (entry.kind !== "tool-call") return null;
  const id = typeof entry.id === "string" ? entry.id : "";
  const name = nonEmptyString(entry.name) ?? nonEmptyString(entry.toolName);
  if (id.length === 0 || name === null) return null;
  return {
    id,
    name,
    status: toolStepStatus(entry.status),
    detail: typeof entry.summary === "string" ? entry.summary : "",
  };
}

function toolStepStatus(status: unknown): GrokBotTranscriptToolStep["status"] {
  if (status === "failed" || status === "error") return "failed";
  if (status === "done" || status === "aborted") return "completed";
  return "inProgress";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function permissionCardPending(entry: DynamicRecord): boolean {
  if (entry.kind !== "send-message" || !isDynamicRecord(entry.message)) return false;
  if (entry.message.type !== "local-tool-permission") return false;
  const ask = isDynamicRecord(entry.message.ask) ? entry.message.ask : null;
  if (!ask) return true;
  return typeof ask.status !== "string" || !RESOLVED_PERMISSION.has(ask.status);
}

function lastUserPromptIndex(entries: readonly unknown[], prompt: string): number {
  const wanted = prompt.trim();
  let found = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isDynamicRecord(entry) || transcriptRole(entry) !== "USER") continue;
    if (transcriptText(entry).trim() !== wanted) continue;
    found = index;
  }
  return found;
}

function transcriptText(entry: DynamicRecord): string {
  if (typeof entry.text === "string") return entry.text;
  if (typeof entry.content === "string") return entry.content;
  const message = isDynamicRecord(entry.message) ? entry.message : null;
  if (!message) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string" && (message.type === "text" || message.type === undefined))
    return message.content;
  return "";
}
